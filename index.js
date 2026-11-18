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

app.listen(port, () => {
  console.log(`server app listening on port ${port}`);
});
