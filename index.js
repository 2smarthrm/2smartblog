 
 


import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import cors from "cors";
import session from "express-session";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss-clean";
import hpp from "hpp";
import rateLimit from "express-rate-limit";
import express from "express";

// Criar app Express
const app = express();
app.use(express.json());

// CORS com múltiplos origins
const allowedOrigins = ["http://127.0.0.1:5500", "https://2smart.pt"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error("Acesso bloqueado por CORS"), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

// Segurança
app.use(helmet());
app.use(hpp());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(mongoSanitize());
app.use(xss());

// Sessão (serverless não mantém sessão entre invocações, mas funciona para cookies)
app.use(session({ 
  secret: "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));
const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";

// MongoDB 
let client;
let clientPromise;

if (!global._mongoClientPromise) {
  client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
}

clientPromise = global._mongoClientPromise;

let usersCollection;
let blogsCollection;

// Middleware para carregar collections
async function loadCollections() {
  const client = await clientPromise;
  const db = client.db("blog_db");
  usersCollection = db.collection("users");
  blogsCollection = db.collection("blogs");
}

// Middleware de autenticação
function auth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Não autenticado" });
  next();
}

// ROTAS AUTH
app.post("/api/auth/register", async (req, res) => {
  await loadCollections();
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });
  const existing = await usersCollection.findOne({ email });
  if (existing) return res.status(409).json({ error: "Email já cadastrado" });
  const hash = await bcrypt.hash(password, 10);
  const result = await usersCollection.insertOne({ name, email, password: hash });
  req.session.userId = result.insertedId;
  res.status(201).json({ id: result.insertedId, name, email });
});

app.post("/api/auth/login", async (req, res) => {
  await loadCollections();
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Campos obrigatórios" });
  const user = await usersCollection.findOne({ email });
  if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });
  req.session.userId = user._id;
  res.json({ id: user._id, name: user.name, email: user.email });
});

app.post("/api/auth/logout", auth, (req, res) => {
  req.session.destroy(() => res.json({ message: "Logout feito" }));
});

app.get("/api/auth/me", auth, async (req, res) => {
  await loadCollections();
  const user = await usersCollection.findOne(
    { _id: new ObjectId(req.session.userId) },
    { projection: { password: 0 } }
  );
  res.json(user);
});

// ROTAS BLOGS
app.post("/api/blogs", auth, async (req, res) => {
  await loadCollections();
  const { blog_title, blog_description, blog_short_description, blog_postdate, blog_category, blog_image_url } = req.body || {};
  if (!blog_title || !blog_description || !blog_short_description || !blog_category) return res.status(400).json({ error: "Campos obrigatórios faltando" });
  const doc = {
    blog_title,
    blog_description,
    blog_short_description,
    blog_postdate: blog_postdate ? new Date(blog_postdate) : new Date(),
    blog_category,
    blog_image_url: blog_image_url || "",
    author: new ObjectId(req.session.userId),
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const result = await blogsCollection.insertOne(doc);
  res.status(201).json({ _id: result.insertedId, ...doc });
});

app.get("/api/blogs", async (req, res) => {
  await loadCollections();
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
  const items = await blogsCollection
    .find(filter)
    .sort({ blog_postdate: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .toArray();
  const total = await blogsCollection.countDocuments(filter);
  const articles = items.map(blog => ({
    source: { id: null, name: "MyBlogAPI" },
    author: blog.author?.toString() || "Unknown",
    title: blog.blog_title,
    description: blog.blog_description,
    short_description: blog.blog_short_description,
    urlToImage: blog.blog_image_url || "",
    publishedAt: blog.blog_postdate.toISOString(),
    content: blog.blog_description,
    category: blog.blog_category,
    id: blog._id
  }));
  res.json({ status: "ok", totalResults: total, articles });
});















app.get("/", async (req, res) => {
  await loadCollections();
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
  const items = await blogsCollection
    .find(filter)
    .sort({ blog_postdate: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .toArray();
  const total = await blogsCollection.countDocuments(filter);
  const articles = items.map(blog => ({
    source: { id: null, name: "MyBlogAPI" },
    author: blog.author?.toString() || "Unknown",
    title: blog.blog_title,
    description: blog.blog_description,
    short_description: blog.blog_short_description,
    urlToImage: blog.blog_image_url || "",
    publishedAt: blog.blog_postdate.toISOString(),
    content: blog.blog_description,
    category: blog.blog_category,
    id: blog._id
  }));
  res.json({ status: "ok", totalResults: total, articles });
});











app.get("/api/blogs/:id", async (req, res) => {
  await loadCollections();
  try {
    const post = await blogsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!post) return res.status(404).json({ error: "Post não encontrado" });
    res.json(post);
  } catch {
    res.status(400).json({ error: "ID inválido" });
  }
});

app.put("/api/blogs/:id", async (req, res) => {
  await loadCollections();
  try {
    const updateData = { ...req.body, updatedAt: new Date() };
    if (updateData.blog_postdate) updateData.blog_postdate = new Date(updateData.blog_postdate);
    const result = await blogsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData },
      { returnDocument: "after" }
    );
    if (!result.value) return res.status(404).json({ error: "Post não encontrado" });
    res.json(result.value);
  } catch(error) {
    console.log(error);
    res.status(400).json({ error: "Erro ao atualizar" });
  }
});

app.delete("/api/blogs/:id", async (req, res) => {
  await loadCollections();
  try {
    const result = await blogsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Post não encontrado" });
    res.json({ message: "Post removido com sucesso" });
  } catch {
    res.status(400).json({ error: "Erro ao remover" });
  }
});

// Exportar app para Vercel
export default app;
