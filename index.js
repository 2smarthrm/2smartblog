 

 
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import Cors from "cors";
const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";

const allowedOrigins = ["http://127.0.0.1:5500", "https://2smart.pt"];
const cors = Cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Acesso bloqueado por CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
});

function runCors(req, res) {
  return new Promise((resolve, reject) => {
    cors(req, res, (result) => (result instanceof Error ? reject(result) : resolve(result)));
  });
}

let client;
let clientPromise;
if (!global._mongoClientPromise) {
  client = new MongoClient(process.env.MONGODB_URI);
  global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

let usersCollection;
let blogsCollection;

async function loadCollections() {
  const client = await clientPromise;
  const db = client.db("blog_db");
  usersCollection = db.collection("users");
  blogsCollection = db.collection("blogs");
}

export default async function handler(req, res) {
  try {
    await runCors(req, res);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  await loadCollections();
  const { method, body, query } = req;
  const path = req.url;

  // ================= AUTH =================
  if (path === "/api/auth/register" && method === "POST") {
    const { name, email, password } = body || {};
    if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });
    if (await usersCollection.findOne({ email })) return res.status(409).json({ error: "Email já cadastrado" });
    const hash = await bcrypt.hash(password, 10);
    const result = await usersCollection.insertOne({ name, email, password: hash });
    return res.status(201).json({ id: result.insertedId, name, email });
  }

  if (path === "/api/auth/login" && method === "POST") {
    const { email, password } = body || {};
    const user = await usersCollection.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) 
      return res.status(401).json({ error: "Credenciais inválidas" });
    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return res.json({ message: "Logout feito" }); // Sessão serverless simplificada
  }

  if (path === "/api/auth/me" && method === "GET") {
    return res.status(200).json({ message: "Me endpoint requires session, not implemented in serverless" });
  }

  // ================= BLOGS =================
  if (path === "/api/blogs" && method === "GET") {
    const items = await blogsCollection.find().sort({ blog_postdate: -1 }).toArray();
    return res.json(items);
  }

  if (path === "/api/blogs" && method === "POST") {
    const { blog_title, blog_description, blog_short_description, blog_category, blog_image_url } = body || {};
    if (!blog_title || !blog_description || !blog_short_description || !blog_category)
      return res.status(400).json({ error: "Campos obrigatórios faltando" });
    const doc = {
      blog_title,
      blog_description,
      blog_short_description,
      blog_category,
      blog_image_url: blog_image_url || "",
      blog_postdate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await blogsCollection.insertOne(doc);
    return res.status(201).json({ _id: result.insertedId, ...doc });
  }

  const blogIdMatch = path.match(/^\/api\/blogs\/([\w\d]+)$/);
  if (blogIdMatch) {
    const id = blogIdMatch[1];

    if (method === "GET") {
      const post = await blogsCollection.findOne({ _id: new ObjectId(id) });
      if (!post) return res.status(404).json({ error: "Post não encontrado" });
      return res.json(post);
    }

    if (method === "PUT") {
      const updateData = { ...body, updatedAt: new Date() };
      if (updateData.blog_postdate) updateData.blog_postdate = new Date(updateData.blog_postdate);
      const result = await blogsCollection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateData },
        { returnDocument: "after" }
      );
      if (!result.value) return res.status(404).json({ error: "Post não encontrado" });
      return res.json(result.value);
    }

    if (method === "DELETE") {
      const result = await blogsCollection.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) return res.status(404).json({ error: "Post não encontrado" });
      return res.json({ message: "Post removido com sucesso" });
    }
  }

  res.status(405).json({ error: "Método não permitido" });
}



