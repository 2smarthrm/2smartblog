import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import Cors from "cors";

// ================== CORS ==================
const allowedOrigins = ["http://127.0.0.1:5500", "https://2smart.pt", "https://2smsite.vercel.app"];
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

// ================== Handler ==================
export default async function handler(req, res) {
  try {
    await runCors(req, res);
    await loadCollections();
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  const { method, body, query } = req;
  const path = req.url;
  const blogIdMatch = path.match(/^\/api\/blogs\/([\w\d]+)$/);
  const id = blogIdMatch ? blogIdMatch[1] : null;

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
    return res.json({ message: "Logout feito" });
  }

  // ================= BLOGS =================
  // GET /api/blogs - lista com status + totalResults + articles
  if (path === "/api/blogs" && method === "GET") {
    const { category, q, page = 1, limit = 10 } = query;
    const filter = {};

    if (category) filter.blog_category = category;
    if (q) {
      filter.$or = [
        { blog_title: { $regex: q, $options: "i" } },
        { blog_short_description: { $regex: q, $options: "i" } },
        { blog_description: { $regex: q, $options: "i" } },
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

    return res.json({ status: "ok", totalResults: total, articles });
  }

  // POST /api/blogs - criar post
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
      updatedAt: new Date()
    };
    const result = await blogsCollection.insertOne(doc);
    const article = { _id: result.insertedId, ...doc };
    return res.status(201).json({ status: "ok", article });
  }

  // /api/blogs/:id
  if (id) {
    if (method === "GET") {
      const post = await blogsCollection.findOne({ _id: new ObjectId(id) });
      if (!post) return res.status(404).json({ status: "error", error: "Post não encontrado" });
      const article = {
        source: { id: null, name: "MyBlogAPI" },
        author: post.author?.toString() || "Unknown",
        title: post.blog_title,
        description: post.blog_description,
        short_description: post.blog_short_description,
        urlToImage: post.blog_image_url || "",
        publishedAt: post.blog_postdate.toISOString(),
        content: post.blog_description,
        category: post.blog_category,
        id: post._id
      };
      return res.json({ status: "ok", article });
    }

    if (method === "PUT") {
      const updateData = { ...body, updatedAt: new Date() };
      if (updateData.blog_postdate) updateData.blog_postdate = new Date(updateData.blog_postdate);
      const result = await blogsCollection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateData },
        { returnDocument: "after" }
      );
      if (!result.value) return res.status(404).json({ status: "error", error: "Post não encontrado" });
      return res.json({ status: "ok", article: result.value });
    }

    if (method === "DELETE") {
      const result = await blogsCollection.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) return res.status(404).json({ status: "error", error: "Post não encontrado" });
      return res.json({ status: "ok", message: "Post removido com sucesso" });
    }
  }

  return res.status(405).json({ error: "Método não permitido" });
}
