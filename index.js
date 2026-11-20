import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import Stripe from "stripe";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
const port = 8000;

const mongobdurl = process.env.MONGODB_URL;
const client = new MongoClient(mongobdurl);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
const mongodbClient = await connectToMongoDB();
const db = mongodbClient.db("fix-mate");
const users = db.collection("user");
const sessions = db.collection("session");
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");
await paymentsCollection.createIndex({ stripeSessionId: 1 }, { unique: true });

const BDT_TO_USD_RATE = Number(process.env.BDT_TO_USD_RATE);
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    // Verify Stripe signature
    try {
      const signature = req.headers["stripe-signature"];

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      console.error("Stripe signature verification failed:", error.message);

      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type !== "checkout.session.completed") {
        return res.send({ received: true });
      }

      const session = event.data.object;

      // Only process successful payments
      if (session.payment_status !== "paid") {
        return res.send({ received: true });
      }

      const bookingId = session.metadata?.bookingId;
      const customerEmail = session.metadata?.customerEmail;

      if (!bookingId || !ObjectId.isValid(bookingId) || !customerEmail) {
        console.error("Invalid booking metadata:", session.metadata);

        return res.status(400).send({
          received: false,
          message: "Invalid checkout metadata",
        });
      }

      if (session.currency !== "usd") {
        return res.status(400).send({
          received: false,
          message: "Unexpected payment currency",
        });
      }

      const transactionId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;

      if (!transactionId) {
        return res.status(400).send({
          received: false,
          message: "Stripe PaymentIntent ID not found",
        });
      }

      const normalizedEmail = customerEmail.toLowerCase();

      // Find the exact booking associated with this Checkout Session
      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(bookingId),
        customerEmail: normalizedEmail,
        status: "completed",
        stripeSessionId: session.id,
      });

      if (!booking) {
        // Return 500 so Stripe can retry if booking data is temporarily unavailable
        console.error("Matching booking not found:", bookingId);

        return res.status(500).send({
          received: false,
          message: "Matching booking not found",
        });
      }

      const paidAmount = session.amount_total / 100;

      if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
        return res.status(400).send({
          received: false,
          message: "Invalid Stripe payment amount",
        });
      }

      const paidAt = new Date(
        (session.created || Math.floor(Date.now() / 1000)) * 1000,
      );

      // Update booking payment status
      await bookingsCollection.updateOne(
        {
          _id: booking._id,
          customerEmail: normalizedEmail,
          stripeSessionId: session.id,
          status: "completed",
        },
        {
          $set: {
            paymentStatus: "paid",
            stripePaymentIntentId: transactionId,
            paidAt,
            updatedAt: new Date(),
          },
        },
      );

      // Save transaction in payments collection.
      // Unique stripeSessionId + $setOnInsert prevents duplicate records
      // when Stripe sends the same webhook more than once.
      await paymentsCollection.updateOne(
        {
          stripeSessionId: session.id,
        },
        {
          $setOnInsert: {
            bookingId: booking._id.toString(),

            serviceTitle: booking.serviceTitle,

            customerName: booking.customerName,
            customerEmail: normalizedEmail,

            technicianName: booking.technicianName,
            technicianEmail: booking.technicianEmail,

            amount: paidAmount,
            currency: "usd",

            transactionId,
            stripeSessionId: session.id,

            paymentStatus: "paid",
            paidAt,
          },
        },
        {
          upsert: true,
        },
      );

      return res.send({
        received: true,
        message: "Payment processed successfully",
      });
    } catch (error) {
      console.error("Webhook processing error:", error);

      return res.status(500).send({
        received: false,
        message: "Webhook processing failed",
      });
    }
  },
);

app.use(express.json());

const verfiyToken = async (req, res, netx) => {
  const header = req.headers.authorization;
  if (!header) {
    res.status(401).send({ message: "unauthorized", status: 401 });

    return;
  }
  const token = header.split(" ")[1];
  if (!token) {
    res.send({ message: "unauthorized" });
    return;
  }
  const qurey = { token };
  const result = await sessions.findOne(qurey);
  if (!result) {
    res.send({ status: 401, message: "unauthorized" });

    return;
  }

  const userId = result.userId;
  const qureyId = { _id: new ObjectId(userId) };
  const user = await users.findOne(qureyId);
  if (!user) {
    res.status(401).send({ message: "unauthorized" });
  }

  req.user = user;
  netx();
};
app.get("/", (req, res) => {
  res.send("server is runing");
});

// services api
// service post method

// Get all services for admin

app.get("/services", async (req, res) => {
  try {
    const { search, category } = req.query;

    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    // Search by service title (case-insensitive)
    if (search) {
      query.title = {
        $regex: search,
        $options: "i",
      };
    }

    // Filter by category
    if (category && category !== "all") {
      query.category = category;
    }

    const services = await servicesCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).send({
      success: true,
      services,
    });
  } catch (error) {
    console.error("Get services error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch services.",
    });
  }
});
app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(id),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    const technician = await servicesCollection.findOne({
      email: service.technicianEmail,
    });

    res.send({
      success: true,
      data: {
        ...service,
        technician: technician
          ? {
              name: technician.name,
              photo: technician.image,
              area: technician.area,
              bio: technician.bio,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Service details error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch service details",
    });
  }
});
app.get("/services-limit", async (req, res) => {
  const data = await servicesCollection.find().limit(6).toArray();
  res.send(data);
});

app.get("/user/:email", async (req, res) => {
  const { email } = req.params;
  const result = await users.findOne({ email: email });
  res.send(result);
});
app.get("/customer/bookings", verfiyToken, async (req, res) => {
  try {
    if (req.user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can access their bookings",
      });
    }

    const customerEmail = req.user.email.toLowerCase();

    const bookings = await bookingsCollection
      .find({ customerEmail })
      .sort({ createdAt: -1 })
      .toArray();

    res.send({
      success: true,
      bookings,
    });
  } catch (error) {
    console.error("Get customer bookings:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch bookings",
    });
  }
});

app.get("/admin/services", async (req, res) => {
  try {
    const services = await servicesCollection
      .find({})
      .sort({
        approvalStatus: 1,
        createdAt: -1,
      })
      .toArray();

    res.status(200).send({
      success: true,
      services,
    });
  } catch (error) {
    console.error("Get admin services error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch services.",
    });
  }
});
app.get("/technician/services", verfiyToken, async (req, res) => {
  try {
    if (req.user.role !== "technician") {
      return res.status(403).send({
        success: false,
        message: "Access denied",
      });
    }

    const services = await servicesCollection
      .find({
        technicianEmail: req.user.email.toLowerCase(),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send({
      success: true,
      services,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch services",
    });
  }
});

app.get("/bookings", async (req, res) => {
  try {
    const { technicianEmail } = req.query;

    if (!technicianEmail) {
      return res.status(400).send({
        success: false,
        message: "Technician email is required.",
      });
    }

    const bookings = await bookingsCollection
      .find({
        technicianEmail: technicianEmail.toLowerCase(),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send({ success: true, bookings });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch bookings.",
    });
  }
});

app.get("/customer/payments", verfiyToken, async (req, res) => {
  try {
    // Only customer can access payment history
    if (req.user.role !== "customer") {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    const customerEmail = req.user.email.toLowerCase();

    const payments = await paymentsCollection
      .find({
        customerEmail,
        paymentStatus: "paid",
      })
      .sort({ paidAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      payments,
    });
  } catch (error) {
    console.error("Customer payments error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch payment history",
    });
  }
});

app.patch("/bookings/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, finalAmount } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking ID.",
      });
    }

    const allowedTransitions = {
      requested: ["accepted", "rejected"],
      accepted: ["in-progress"],
      "in-progress": ["completed"],
    };

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).send({
        success: false,
        message: "Booking not found.",
      });
    }

    if (!allowedTransitions[booking.status]?.includes(status)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking status transition.",
      });
    }

    const updateData = {
      status,
      updatedAt: new Date(),
    };

    if (status === "completed") {
      if (
        typeof finalAmount !== "number" ||
        !Number.isFinite(finalAmount) ||
        finalAmount <= 0
      ) {
        return res.status(400).send({
          success: false,
          message: "A valid final amount is required.",
        });
      }

      updateData.finalAmount = finalAmount;
    }

    await bookingsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData },
    );

    res.send({
      success: true,
      message: `Booking ${status} successfully.`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to update booking.",
    });
  }
});

app.patch("/services/:id", verfiyToken, async (req, res) => {
  try {
    if (req.user.role !== "technician") {
      return res.status(403).send({
        success: false,
        message: "Only technicians can update services.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    const {
      title,
      category,
      description,
      image,
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
    } = req.body;

    const validCategories = [
      "Smartphone",
      "Laptop & PC",
      "AC",
      "Refrigerator",
      "TV",
      "Washing Machine",
      "Electrical",
    ];

    const validModes = ["Home Visit", "Shop Drop-off"];

    if (
      !title?.trim() ||
      !category ||
      !description?.trim() ||
      !image ||
      !estimatedDuration?.trim() ||
      !serviceMode ||
      !serviceArea?.trim()
    ) {
      return res.status(400).send({
        success: false,
        message: "Please provide all required service fields.",
      });
    }

    if (!validCategories.includes(category)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service category.",
      });
    }

    if (!validModes.includes(serviceMode)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service mode.",
      });
    }

    const price = Number(basePrice);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).send({
        success: false,
        message: "Base price must be greater than zero.",
      });
    }

    const updateData = {
      title: title.trim(),
      category,
      description: description.trim(),
      image,
      basePrice: price,
      estimatedDuration: estimatedDuration.trim(),
      serviceMode,
      serviceArea: serviceArea.trim(),

      // Edited services require admin approval again.
      approvalStatus: "pending",

      updatedAt: new Date(),
    };

    const result = await servicesCollection.updateOne(
      {
        _id: new ObjectId(id),
        technicianEmail: req.user.email.toLowerCase(),
      },
      {
        $set: updateData,
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you do not own this service.",
      });
    }

    res.status(200).send({
      success: true,
      message: "Service updated. Waiting for admin approval.",
    });
  } catch (error) {
    console.error("Update service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update service.",
    });
  }
});

// Approve or reject a service
app.patch("/admin/services/:id/approval", async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalStatus } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    if (!["approved", "rejected"].includes(approvalStatus)) {
      return res.status(400).send({
        success: false,
        message: "Invalid approval status.",
      });
    }

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          approvalStatus,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found.",
      });
    }

    res.status(200).send({
      success: true,
      message: `Service ${approvalStatus} successfully.`,
    });
  } catch (error) {
    console.error("Update service approval error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update service approval.",
    });
  }
});
app.patch("/services/:id/availability", verfiyToken, async (req, res) => {
  try {
    if (req.user.role !== "technician") {
      return res.status(403).send({
        success: false,
        message: "Only technicians can change availability.",
      });
    }

    const { id } = req.params;
    const { isAvailable } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    if (typeof isAvailable !== "boolean") {
      return res.status(400).send({
        success: false,
        message: "isAvailable must be a boolean.",
      });
    }

    const result = await servicesCollection.updateOne(
      {
        _id: new ObjectId(id),
        technicianEmail: req.user.email.toLowerCase(),
      },
      {
        $set: {
          isAvailable,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you do not own this service.",
      });
    }

    res.status(200).send({
      success: true,
      message: `Service ${isAvailable ? "enabled" : "disabled"} successfully.`,
      isAvailable,
    });
  } catch (error) {
    console.error("Toggle availability error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update availability.",
    });
  }
});
app.patch("/customer/bookings/:id/cancel", verfiyToken, async (req, res) => {
  try {
    if (req.user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can cancel bookings",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking ID",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        customerEmail: req.user.email.toLowerCase(),
        status: "requested",
      },
      {
        $set: {
          status: "cancelled",
          activeRequestKey: null,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Booking not found or it can no longer be cancelled",
      });
    }

    res.send({
      success: true,
      message: "Booking cancelled successfully",
    });
  } catch (error) {
    console.error("Cancel booking:", error);

    res.status(500).send({
      success: false,
      message: "Failed to cancel booking",
    });
  }
});

app.post("/services", async (req, res) => {
  try {
    const {
      title,
      category,
      description,
      image,
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
      technicianName,
      technicianEmail,
    } = req.body;

    // Validate required fields
    if (
      !title?.trim() ||
      !category ||
      !description?.trim() ||
      !image ||
      !estimatedDuration?.trim() ||
      !serviceMode ||
      !serviceArea?.trim() ||
      !technicianName?.trim() ||
      !technicianEmail?.trim()
    ) {
      return res.status(400).send({
        success: false,
        message: "All required fields must be provided.",
      });
    }

    const allowedCategories = [
      "Smartphone",
      "Laptop & PC",
      "AC",
      "Refrigerator",
      "TV",
      "Washing Machine",
      "Electrical",
    ];

    const allowedModes = ["Home Visit", "Shop Drop-off"];

    const price = Number(basePrice);

    if (!allowedCategories.includes(category)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service category.",
      });
    }

    if (!allowedModes.includes(serviceMode)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service mode.",
      });
    }

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).send({
        success: false,
        message: "Base price must be a positive number.",
      });
    }

    const newService = {
      title: title.trim(),
      category,
      description: description.trim(),
      image,
      basePrice: price,
      estimatedDuration: estimatedDuration.trim(),
      serviceMode,
      serviceArea: serviceArea.trim(),
      technicianName: technicianName.trim(),
      technicianEmail: technicianEmail.trim().toLowerCase(),
      approvalStatus: "pending",
      isAvailable: true,
      createdAt: new Date(),
    };

    const result = await servicesCollection.insertOne(newService);

    res.status(201).send({
      success: true,
      message: "Service submitted and waiting for admin approval.",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Add service error:", error);

    res.status(500).send({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.post("/bookings", verfiyToken, async (req, res) => {
  try {
    const user = req.user;

    // 1. Check authentication
    if (!user) {
      return res.status(401).send({
        success: false,
        message: "Please log in to request a repair",
      });
    }

    // 2. Only customers can request repairs
    if (user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can request a repair",
      });
    }

    const { serviceId, phone, address, preferredDate, problemDescription } =
      req.body;

    // 3. Validate service ID
    if (!serviceId || !ObjectId.isValid(serviceId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    // 4. Validate required fields
    if (
      !phone?.trim() ||
      !address?.trim() ||
      !preferredDate ||
      !problemDescription?.trim()
    ) {
      return res.status(400).send({
        success: false,
        message: "Please fill in all required fields",
      });
    }

    // 5. Validate problem description
    if (problemDescription.trim().length < 20) {
      return res.status(400).send({
        success: false,
        message: "Problem description must be at least 20 characters",
      });
    }

    // 6. Validate preferred date
    if (
      typeof preferredDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid preferred date",
      });
    }

    const parsedDate = new Date(`${preferredDate}T00:00:00.000Z`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== preferredDate
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid preferred date",
      });
    }

    // Compare against Bangladesh local calendar date
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    if (preferredDate < today) {
      return res.status(400).send({
        success: false,
        message: "Preferred date cannot be in the past",
      });
    }

    // 7. Find approved and available service
    const service = await servicesCollection.findOne({
      _id: new ObjectId(serviceId),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Service is no longer available",
      });
    }

    // 8. Get technician information
    const technician = await servicesCollection.findOne({
      email: service.technicianEmail,
    });

    // 9. Get authenticated customer email
    const customerEmail = user.email.toLowerCase();

    // 10. Check existing active booking
    const existingBooking = await bookingsCollection.findOne({
      serviceId: service._id.toString(),
      customerEmail,
      status: {
        $in: ["requested", "accepted", "in-progress"],
      },
    });

    if (existingBooking) {
      return res.status(409).send({
        success: false,
        message: "You already have an active request for this service",
      });
    }

    // 11. Create booking document
    const booking = {
      serviceId: service._id.toString(),

      serviceTitle: service.title,
      serviceImage: service.image,
      category: service.category,
      basePrice: service.basePrice,

      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      technicianPhoto: technician?.image || "",

      customerName: user.name,
      customerEmail,
      customerPhone: phone.trim(),

      address: address.trim(),
      preferredDate: parsedDate,
      problemDescription: problemDescription.trim(),

      status: "requested",
      paymentStatus: "unpaid",

      activeRequestKey: "active",

      createdAt: new Date(),
    };

    // 12. Insert booking
    const result = await bookingsCollection.insertOne(booking);

    return res.status(201).send({
      success: true,
      message: "Repair request submitted successfully",
      data: {
        _id: result.insertedId,
      },
    });
  } catch (error) {
    // Handle duplicate active booking index
    if (error.code === 11000) {
      return res.status(409).send({
        success: false,
        message: "You already have an active request for this service",
      });
    }

    console.error("Booking error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to submit repair request",
    });
  }
});
app.post("/payments/create-checkout-session", verfiyToken, async (req, res) => {
  let checkoutSession;

  try {
    if (req.user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can make payments",
      });
    }

    const { bookingId } = req.body;

    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking ID",
      });
    }

    if (!Number.isFinite(BDT_TO_USD_RATE) || BDT_TO_USD_RATE <= 0) {
      return res.status(500).send({
        success: false,
        message: "Invalid BDT to USD exchange rate",
      });
    }

    const customerEmail = req.user.email.toLowerCase();

    // Find only the logged-in customer's booking
    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(bookingId),
      customerEmail,
    });

    if (!booking) {
      return res.status(404).send({
        success: false,
        message: "Booking not found",
      });
    }

    if (booking.status !== "completed") {
      return res.status(400).send({
        success: false,
        message: "Only completed bookings can be paid",
      });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(400).send({
        success: false,
        message: "This booking is already paid",
      });
    }

    // Final amount is stored in BDT
    const amountBDT = Number(booking.finalAmount ?? booking.basePrice);

    if (!Number.isFinite(amountBDT) || amountBDT <= 0) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking amount",
      });
    }

    // Convert BDT to USD
    const amountUSD = amountBDT / BDT_TO_USD_RATE;

    // Stripe requires USD cents
    const stripeAmount = Math.round(amountUSD * 100);

    if (stripeAmount < 50) {
      return res.status(400).send({
        success: false,
        message: "Payment amount is below Stripe's minimum",
      });
    }

    // Expire a previous unpaid Checkout Session if it is still open
    if (booking.stripeSessionId) {
      try {
        const oldSession = await stripe.checkout.sessions.retrieve(
          booking.stripeSessionId,
        );

        if (oldSession.status === "open") {
          await stripe.checkout.sessions.expire(oldSession.id);
        }
      } catch (error) {
        console.error(
          "Could not expire previous checkout session:",
          error.message,
        );
      }
    }

    // Create Checkout Session
    checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "usd",

            product_data: {
              name: `FixMate - ${booking.serviceTitle}`,
              description: `Original booking amount: BDT ${amountBDT}`,
            },

            unit_amount: stripeAmount,
          },

          quantity: 1,
        },
      ],

      metadata: {
        bookingId: booking._id.toString(),
        customerEmail,
        originalAmountBDT: String(amountBDT),
        exchangeRate: String(BDT_TO_USD_RATE),
      },

      success_url: `${process.env.CLIENT_URL}/payments/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${process.env.CLIENT_URL}/payments/cancel?bookingId=${booking._id}`,
    });

    // Save session ID only if booking is still unpaid and completed
    const updateResult = await bookingsCollection.updateOne(
      {
        _id: booking._id,
        customerEmail,
        status: "completed",
        paymentStatus: "unpaid",
      },
      {
        $set: {
          stripeSessionId: checkoutSession.id,
          exchangeRate: BDT_TO_USD_RATE,
          amountBDT,
          amountUSD: stripeAmount / 100,
          updatedAt: new Date(),
        },
      },
    );

    if (updateResult.matchedCount === 0) {
      await stripe.checkout.sessions.expire(checkoutSession.id);

      return res.status(409).send({
        success: false,
        message: "Booking status changed. Please try again.",
      });
    }

    return res.send({
      success: true,
      url: checkoutSession.url,
      amountBDT,
      amountUSD: stripeAmount / 100,
      exchangeRate: BDT_TO_USD_RATE,
    });
  } catch (error) {
    console.error("Create checkout session error:", error);

    // Expire an unlinked session if something failed after creation
    if (checkoutSession?.id) {
      try {
        await stripe.checkout.sessions.expire(checkoutSession.id);
      } catch (expireError) {
        console.error("Session expiration error:", expireError.message);
      }
    }

    return res.status(500).send({
      success: false,
      message: "Could not create checkout session",
    });
  }
});

app.delete("/services/:id", verfiyToken, async (req, res) => {
  try {
    if (req.user.role !== "technician") {
      return res.status(403).send({
        success: false,
        message: "Only technicians can delete services.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    const result = await servicesCollection.deleteOne({
      _id: new ObjectId(id),
      technicianEmail: req.user.email.toLowerCase(),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you do not own this service.",
      });
    }

    res.status(200).send({
      success: true,
      message: "Service deleted successfully.",
    });
  } catch (error) {
    console.error("Delete service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to delete service.",
    });
  }
});

app.listen(port, () => {
  console.log(`server app listening on port ${port}`);
});

export default app;
