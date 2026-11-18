import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());

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

app.get("/user/:email", async (req, res) => {
  const { email } = req.params;
  const result = await users.findOne({ email: email });
  res.send(result);
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

app.listen(port, () => {
  console.log(`server app listening on port ${port}`);
});
