const express = require("express");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss-clean");
const hpp = require("hpp");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use(cors({
  origin: "http://127.0.0.1:5500",
  credentials: true
}));
app.use(helmet());
app.use(hpp());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// ===== Conexão Mongo com cache =====
const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
let cached = global.mongo;
if (!cached) cached = global.mongo = { conn: null, promise: null };

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    const client = new MongoClient(uri, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
    });
    cached.promise = client.connect().then(client => ({
      client,
      db: client.db("blog_db")
    }));
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ===== Middleware de autenticação (JWT) =====
function auth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Não autenticado" });

  try {
    req.user = jwt.verify(token, "super-secret-key");
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ===== Rotas de Autenticação =====
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });

  const { db } = await connectDB();
  const users = db.collection("users");

  const existing = await users.findOne({ email });
  if (existing) return res.status(409).json({ error: "Email já cadastrado" });

  const hash = await bcrypt.hash(password, 10);
  const result = await users.insertOne({ name, email, password: hash });

  const token = jwt.sign({ id: result.insertedId, email }, "super-secret-key", { expiresIn: "1d" });
  res.cookie("token", token, { httpOnly: true, secure: true, sameSite: "strict" });
  res.status(201).json({ id: result.insertedId, name, email });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Campos obrigatórios" });

  const { db } = await connectDB();
  const users = db.collection("users");

  const user = await users.findOne({ email });
  if (!user) return res.status(401).json({ error: "Credenciais inválidas" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });

  const token = jwt.sign({ id: user._id, email }, "super-secret-key", { expiresIn: "1d" });
  res.cookie("token", token, { httpOnly: true, secure: true, sameSite: "strict" });
  res.json({ id: user._id, name: user.name, email: user.email });
});

app.post("/api/auth/logout", auth, (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logout feito" });
});

app.get("/api/auth/me", auth, async (req, res) => {
  const { db } = await connectDB();
  const users = db.collection("users");
  const user = await users.findOne(
    { _id: new ObjectId(req.user.id) },
    { projection: { password: 0 } }
  );
  res.json(user);
});

// ===== Rotas de Blogs =====
app.post("/api/blogs", auth, async (req, res) => {
  const { blog_title, blog_description, blog_short_description, blog_postdate, blog_category, blog_image_url } = req.body || {};
  if (!blog_title || !blog_description || !blog_short_description || !blog_category)
    return res.status(400).json({ error: "Campos obrigatórios faltando" });

  const { db } = await connectDB();
  const blogs = db.collection("blogs");

  const doc = {
    blog_title,
    blog_description,
    blog_short_description,
    blog_postdate: blog_postdate ? new Date(blog_postdate) : new Date(),
    blog_category,
    blog_image_url: blog_image_url || "",
    author: new ObjectId(req.user.id),
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await blogs.insertOne(doc);
  res.status(201).json({ _id: result.insertedId, ...doc });
});

app.get("/api/blogs", async (req, res) => {
  const { db } = await connectDB();
  const blogs = db.collection("blogs");

  const { category, q, page = 1, limit = 10 } = req.query;
  const filter = {};
  if (category) filter.blog_category = category;
  if (q) {
    filter.$or = [
      { blog_title: { $regex: q, $options: "i" } },
      { blog_short_description: { $regex: q, $options: "i" } },
      { blog_description: { $regex: q, $options: "i" } }
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const items = await blogs.find(filter).sort({ blog_postdate: -1 }).skip(skip).limit(parseInt(limit)).toArray();
  const total = await blogs.countDocuments(filter);

  const articles = items.map(blog => ({
    source: { id: null, name: "MyBlogAPI" },
    author: blog.author?.toString() || "Unknown",
    title: blog.blog_title,
    description: blog.blog_description,
    short_description: blog.blog_short_description,
    urlToImage: blog.blog_image_url || "",
    publishedAt: blog.blog_postdate.toISOString(),
    content: blog.blog_description,
    category: blog.blog_category
  }));

  res.json({ status: "ok", totalResults: total, articles });
});

app.get("/api/blogs/:id", async (req, res) => {
  const { db } = await connectDB();
  const blogs = db.collection("blogs");
  try {
    const post = await blogs.findOne({ _id: new ObjectId(req.params.id) });
    if (!post) return res.status(404).json({ error: "Post não encontrado" });
    res.json(post);
  } catch {
    res.status(400).json({ error: "ID inválido" });
  }
});

app.put("/api/blogs/:id", auth, async (req, res) => {
  const { db } = await connectDB();
  const blogs = db.collection("blogs");
  try {
    const updateData = { ...req.body, updatedAt: new Date() };
    if (updateData.blog_postdate) updateData.blog_postdate = new Date(updateData.blog_postdate);

    const result = await blogs.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData },
      { returnDocument: "after" }
    );
    if (!result.value) return res.status(404).json({ error: "Post não encontrado" });
    res.json(result.value);
  } catch {
    res.status(400).json({ error: "Erro ao atualizar" });
  }
});

app.delete("/api/blogs/:id", auth, async (req, res) => {
  const { db } = await connectDB();
  const blogs = db.collection("blogs");
  try {
    const result = await blogs.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Post não encontrado" });
    res.json({ message: "Post removido com sucesso" });
  } catch {
    res.status(400).json({ error: "Erro ao remover" });
  }
});

// ===== Exportar para Vercel =====
module.exports = app;

