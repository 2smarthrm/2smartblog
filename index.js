import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import Cors from "cors";

// Configurar CORS
const allowedOrigins = ["http://127.0.0.1:5500", "https://2smart.pt"];
const cors = Cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Acesso bloqueado por CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
});

// Helper para rodar CORS em handlers serverless
function runCors(req, res) {
  return new Promise((resolve, reject) => {
    cors(req, res, (result) => {
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });
}

const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";

let client;
let clientPromise;
if (!global._mongoClientPromise) {
  client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;


 
export default async function handler(req, res) {
  const client = await clientPromise;
  const db = client.db("blog_db");
  const users = db.collection("users");
  const blogs = db.collection("blogs");

  const { method, query, body } = req;

  // ROTAS AUTH
  if (req.url.startsWith("/api/auth/register") && method === "POST") {
    const { name, email, password } = body;
    if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });
    if (await users.findOne({ email })) return res.status(409).json({ error: "Email já cadastrado" });
    const hash = await bcrypt.hash(password, 10);
    const result = await users.insertOne({ name, email, password: hash });
    return res.status(201).json({ id: result.insertedId, name, email });
  }

  if (req.url.startsWith("/api/auth/login") && method === "POST") {
    const { email, password } = body;
    const user = await users.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: "Credenciais inválidas" });
    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  // ROTAS BLOGS
  if (req.url.startsWith("/api/blogs") && method === "GET") {
    const items = await blogs.find().sort({ blog_postdate: -1 }).toArray();
    return res.json(items);
  }

  if (req.url.startsWith("/api/blogs") && method === "POST") {
    const { blog_title, blog_description, blog_short_description, blog_category, blog_image_url } = body;
    if (!blog_title || !blog_description || !blog_short_description || !blog_category)
      return res.status(400).json({ error: "Campos obrigatórios" });
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
    const result = await blogs.insertOne(doc);
    return res.status(201).json({ _id: result.insertedId, ...doc });
  }

  if (req.url.match(/^\/api\/blogs\/[\w\d]+$/) && method === "PUT") {
    const id = req.url.split("/").pop();
    const updateData = { ...body, updatedAt: new Date() };
    const result = await blogs.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updateData },
      { returnDocument: "after" }
    );
    if (!result.value) return res.status(404).json({ error: "Post não encontrado" });
    return res.json(result.value);
  }

  if (req.url.match(/^\/api\/blogs\/[\w\d]+$/) && method === "DELETE") {
    const id = req.url.split("/").pop();
    const result = await blogs.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Post não encontrado" });
    return res.json({ message: "Post removido com sucesso" });
  }

  if (req.url.match(/^\/api\/blogs\/[\w\d]+$/) && method === "GET") {
    const id = req.url.split("/").pop();
    const post = await blogs.findOne({ _id: new ObjectId(id) });
    if (!post) return res.status(404).json({ error: "Post não encontrado" });
    return res.json(post);
  }

  res.status(405).json({ error: "Método não permitido" });
}
