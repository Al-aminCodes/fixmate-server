import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
app.use(cors());
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

    const technician = await techniciansCollection.findOne({
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

app.listen(port, () => {
  console.log(`server app listening on port ${port}`);
});
