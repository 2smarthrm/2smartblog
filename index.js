import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import Cors from "cors";

// ================== CORS ==================
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "https://2smart.pt",
  "https://2smsite.vercel.app"
];

const cors = Cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Acesso bloqueado por CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

function runCors(req, res) {
  return new Promise((resolve, reject) => {
    cors(req, res, (result) => (result instanceof Error ? reject(result) : resolve(result)));
  });
}

// ================== MongoDB ==================
const MONGODB_URI = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";

let client;
let clientPromise;

if (!global._mongoClientPromise) {
  client = new MongoClient(MONGODB_URI);
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

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function toIso(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ================== Handler ==================
export default async function handler(req, res) {
  try {
    await runCors(req, res);
    await loadCollections();
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  // Handle CORS preflight quickly
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const { method, body, query } = req;
  const path = req.url; // Next.js disponibiliza req.query; usamos path para "rotear"

  // Helpers de path
  const blogIdMatch = path.match(/^\/api\/blogs\/([\w\d]+)$/);
  const userIdMatch = path.match(/^\/api\/users\/([\w\d]+)$/);
  const blogId = blogIdMatch ? blogIdMatch[1] : null;
  const url = new URL(req.url, "http://localhost"); // base dummy para usar URLSearchParams
  const searchParams = url.searchParams;

  // ================= AUTH =================

  // POST /api/auth/register
  if (path === "/api/auth/register" && method === "POST") {
    const { name, email, password } = body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Campos obrigatórios" });
    }
    if (await usersCollection.findOne({ email })) {
      return res.status(409).json({ error: "Email já cadastrado" });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await usersCollection.insertOne({ name, email, password: hash, createdAt: new Date() });
    return res.status(201).json({ id: result.insertedId, name, email });
  }

  // POST /api/auth/login
  if (path === "/api/auth/login" && method === "POST") {
    const { email, password } = body || {};
    const user = await usersCollection.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }
    // Sem sessão/cookie no servidor: devolvemos dados básicos para o frontend gravar em sessionStorage
    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  // GET /api/auth/me?id=<userId>
  // Verifica “sessão” do frontend (sessionStorage) e devolve dados atualizados do utilizador
  if (path.startsWith("/api/auth/me") && method === "GET") {
    const id = query?.id || searchParams.get("id");
    if (!id) return res.status(400).json({ error: "Falta o parâmetro id" });

    const _id = toObjectId(id);
    if (!_id) return res.status(400).json({ error: "ID inválido" });

    const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado" });

    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  // (Opcional) GET /api/users/:id — espelho de /auth/me mas por path param
  if (userIdMatch && method === "GET") {
    const _id = toObjectId(userIdMatch[1]);
    if (!_id) return res.status(400).json({ error: "ID inválido" });

    const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado" });

    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  // POST /api/auth/logout
  if (path === "/api/auth/logout" && method === "POST") {
    // Sem sessão server-side para destruir; devolvemos apenas OK
    return res.json({ message: "Logout feito" });
  }

  // ================= BLOGS =================

  // GET /api/blogs
  if (path === "/api/blogs" && method === "GET") {
    const category = query?.category ?? searchParams.get("category") ?? undefined;
    const q = query?.q ?? searchParams.get("q") ?? undefined;
    const page = parseInt(query?.page ?? searchParams.get("page") ?? "1", 10);
    const limit = parseInt(query?.limit ?? searchParams.get("limit") ?? "10", 10);

    const filter = {};
    if (category) filter.blog_category = category;
    if (q) {
      filter.$or = [
        { blog_title: { $regex: q, $options: "i" } },
        { blog_short_description: { $regex: q, $options: "i" } },
        { blog_description: { $regex: q, $options: "i" } },
      ];
    }

    const skip = (page - 1) * limit;
    const items = await blogsCollection
      .find(filter)
      .sort({ blog_postdate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await blogsCollection.countDocuments(filter);

    const articles = items.map(blog => ({
      source: { id: null, name: "MyBlogAPI" },
      author: blog.author?.toString() || "Unknown",
      title: blog.blog_title,
      description: blog.blog_description,
      short_description: blog.blog_short_description,
      urlToImage: blog.blog_image_url || "",
      publishedAt: toIso(blog.blog_postdate) || toIso(blog.createdAt) || toIso(blog.updatedAt) || toIso(new Date()),
      content: blog.blog_description,
      category: blog.blog_category,
      id: blog._id
    }));

    return res.json({ status: "ok", totalResults: total, articles });
  }

  // POST /api/blogs — criar post
  if (path === "/api/blogs" && method === "POST") {
    const { blog_title, blog_description, blog_short_description, blog_category, blog_image_url, blog_postdate } = body || {};

    if (!blog_title || !blog_description || !blog_short_description || !blog_category) {
      return res.status(400).json({ error: "Campos obrigatórios faltando" });
    }

    const now = new Date();
    const doc = {
      blog_title,
      blog_description,
      blog_short_description,
      blog_category,
      blog_image_url: blog_image_url || "",
      blog_postdate: blog_postdate ? new Date(blog_postdate) : now,
      createdAt: now,
      updatedAt: now
    };

    const result = await blogsCollection.insertOne(doc);
    const article = { _id: result.insertedId, ...doc };
    return res.status(201).json({ status: "ok", article });
  }

  // /api/blogs/:id
  if (blogId) {
    const _id = toObjectId(blogId);
    if (!_id) return res.status(400).json({ status: "error", error: "ID inválido" });

    // GET /api/blogs/:id
    if (method === "GET") {
      const post = await blogsCollection.findOne({ _id });
      if (!post) return res.status(404).json({ status: "error", error: "Post não encontrado" });

      const article = {
        source: { id: null, name: "MyBlogAPI" },
        author: post.author?.toString() || "Unknown",
        title: post.blog_title,
        description: post.blog_description,
        short_description: post.blog_short_description,
        urlToImage: post.blog_image_url || "",
        publishedAt: toIso(post.blog_postdate) || toIso(post.createdAt) || toIso(post.updatedAt),
        content: post.blog_description,
        category: post.blog_category,
        id: post._id
      };
      return res.json({ status: "ok", article });
    }

    // PUT /api/blogs/:id
    if (method === "PUT") {
      const updateData = { ...body, updatedAt: new Date() };
      if (updateData.blog_postdate) updateData.blog_postdate = new Date(updateData.blog_postdate);

      const result = await blogsCollection.findOneAndUpdate(
        { _id },
        { $set: updateData },
        { returnDocument: "after" }
      );

      if (!result.value) return res.status(404).json({ status: "error", error: "Post não encontrado - "+_id });
      return res.json({ status: "ok", article: result.value });
    }

    // DELETE /api/blogs/:id
    if (method === "DELETE") {
      const result = await blogsCollection.deleteOne({ _id });
      if (result.deletedCount === 0) return res.status(404).json({ status: "error", error: "Post não encontrado" });
      return res.json({ status: "ok", message: "Post removido com sucesso" });
    }
  }

  return res.status(405).json({ error: "Método não permitido" });
}
