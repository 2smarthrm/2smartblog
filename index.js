import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import Cors from "cors";
import cookie from "cookie";
import jwt from "jsonwebtoken";

// ================== CONFIG / ENV ==================
const MONGODB_URI =  "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";

const DB_NAME = process.env.MONGODB_DB || "blog_db";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SUPER_SECRET";
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 dias

// Lista de origens permitidas para CORS
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000",
  "https://2smart.pt",
  "https://2smsite.vercel.app",
  "https://2smartblog.vercel.app",
  "https://blogsmart.vercel.app"
];

// ================== CORS ==================
const cors = Cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Acesso bloqueado por CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true, // <<< IMPORTANTE quando há cookies/credenciais
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

function runCors(req, res) {
  return new Promise((resolve, reject) => {
    cors(req, res, (result) =>
      result instanceof Error ? reject(result) : resolve(result)
    );
  });
}

// Ecoar cabeçalhos CORS (útil para garantir no 204/OPTIONS)
function setCorsEchoHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS"
    );
  }
}

// ================== MongoDB (conn reusável em serverless) ==================
let client;
let clientPromise;
let usersCollection;
let blogsCollection;

async function getDb() {
  if (!clientPromise) {
    client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect();
  }
  const conn = await clientPromise;
  const db = conn.db(DB_NAME);
  usersCollection = usersCollection || db.collection("users");
  blogsCollection = blogsCollection || db.collection("blogs");
  return db;
}

// ================== Helpers ==================
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

function signToken(userId) {
  return jwt.sign({ uid: String(userId) }, JWT_SECRET, { expiresIn: "7d" });
}

function readTokenFromReq(req) {
  const raw = req.headers.cookie || "";
  const parsed = cookie.parse(raw || "");
  const tok = parsed[COOKIE_NAME];
  if (!tok) return null;
  try {
    return jwt.verify(tok, JWT_SECRET);
  } catch {
    return null;
  }
}

function setLoginCookie(res, token, origin) {
  // Em cross-site precisas de SameSite=None; Secure
  // O fetch está a ir para https://2smartblog.vercel.app → resposta é HTTPS → Secure é aceite.
  const isSecure = true; // Vercel é HTTPS. Mantém true.
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "none",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    })
  );
}

function clearLoginCookie(res) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(COOKIE_NAME, "", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      expires: new Date(0),
    })
  );
}

// ================== Handler ==================
export default async function handler(req, res) {
  // CORS primeiro
  try {
    await runCors(req, res);
    setCorsEchoHeaders(req, res);
  } catch (err) {
    return res.status(403).json({ error: err.message || "CORS bloqueado" });
  }

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Mongo
  try {
    await getDb();
  } catch (e) {
    return res.status(500).json({ error: "Falha a ligar ao MongoDB" });
  }

  const { method, body, query } = req;
  // Em Next, req.url contém /api/...; vamos roteá-lo manualmente
  const path = req.url || "";

  // Helpers de path
  const blogIdMatch = path.match(/^\/api\/blogs\/([\w\d]+)$/);
  const userIdMatch = path.match(/^\/api\/users\/([\w\d]+)$/);
  const url = new URL(req.url, "http://localhost"); // base dummy
  const searchParams = url.searchParams;

  // ============ AUTH ============
  // POST /api/auth/register
  if (path === "/api/auth/register" && method === "POST") {
    const { name, email, password } = body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Campos obrigatórios" });
    }
    const exists = await usersCollection.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email já cadastrado" });

    const hash = await bcrypt.hash(password, 10);
    const result = await usersCollection.insertOne({
      name,
      email,
      password: hash,
      createdAt: new Date(),
    });

    return res
      .status(201)
      .json({ id: result.insertedId, name, email, createdAt: new Date() });
  }

  // POST /api/auth/login
  if (path === "/api/auth/login" && method === "POST") {
    const { email, password } = body || {};
    if (!email || !password)
      return res.status(400).json({ error: "Campos obrigatórios" });

    const user = await usersCollection.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // JWT em cookie httpOnly (cross-site ready)
    const token = signToken(user._id);
    setLoginCookie(res);

    // CORREÇÃO: passamos o token aqui:
    setLoginCookie(res, token, req.headers.origin);

    return res.json({
      id: user._id,
      name: user.name,
      email: user.email,
    });
  }

  // POST /api/auth/logout
  if (path === "/api/auth/logout" && method === "POST") {
    clearLoginCookie(res);
    return res.json({ message: "Logout feito" });
  }

  // GET /api/auth/me
  if (path.startsWith("/api/auth/me") && method === "GET") {
    // 1) Tenta cookie JWT
    const t = readTokenFromReq(req);
    if (t?.uid) {
      const _id = toObjectId(t.uid);
      if (_id) {
        const user = await usersCollection.findOne(
          { _id },
          { projection: { password: 0 } }
        );
        if (user) {
          return res.json({
            id: user._id,
            name: user.name,
            email: user.email,
          });
        }
      }
    }
    // 2) Fallback: ?id=...
    const id = query?.id || searchParams.get("id");
    if (!id) return res.status(401).json({ error: "Sem sessão" });
    const _id = toObjectId(id);
    if (!_id) return res.status(400).json({ error: "ID inválido" });

    const user = await usersCollection.findOne(
      { _id },
      { projection: { password: 0 } }
    );
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado" });

    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  // (Opcional) GET /api/users/:id
  if (userIdMatch && method === "GET") {
    const _id = toObjectId(userIdMatch[1]);
    if (!_id) return res.status(400).json({ error: "ID inválido" });

    const user = await usersCollection.findOne(
      { _id },
      { projection: { password: 0 } }
    );
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado" });

    return res.json({ id: user._id, name: user.name, email: user.email });
  }

  // ============ BLOGS ============
  // GET /api/blogs
  if (path === "/api/blogs" && method === "GET") {
    const category = query?.category ?? searchParams.get("category") ?? undefined;
    const q = query?.q ?? searchParams.get("q") ?? undefined;
    const page = parseInt(
      query?.page ?? searchParams.get("page") ?? "1",
      10
    );
    const limit = parseInt(
      query?.limit ?? searchParams.get("limit") ?? "10",
      10
    );

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

    const articles = items.map((blog) => ({
      source: { id: null, name: "MyBlogAPI" },
      author: blog.author?.toString() || "Unknown",
      title: blog.blog_title,
      description: blog.blog_description,
      short_description: blog.blog_short_description,
      urlToImage: blog.blog_image_url || "",
      publishedAt:
        toIso(blog.blog_postdate) ||
        toIso(blog.createdAt) ||
        toIso(blog.updatedAt) ||
        toIso(new Date()),
      content: blog.blog_description,
      category: blog.blog_category,
      id: blog._id,
    }));

    return res.json({ status: "ok", totalResults: total, articles });
  }

  // POST /api/blogs — criar
  if (path === "/api/blogs" && method === "POST") {
    const {
      blog_title,
      blog_description,
      blog_short_description,
      blog_category,
      blog_image_url,
      blog_postdate,
    } = body || {};

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
      updatedAt: now,
    };

    const result = await blogsCollection.insertOne(doc);
    const saved = { _id: result.insertedId, ...doc };

    const article = {
      source: { id: null, name: "MyBlogAPI" },
      author: "Unknown",
      title: saved.blog_title,
      description: saved.blog_description,
      short_description: saved.blog_short_description,
      urlToImage: saved.blog_image_url || "",
      publishedAt:
        toIso(saved.blog_postdate) ||
        toIso(saved.createdAt) ||
        toIso(saved.updatedAt),
      content: saved.blog_description,
      category: saved.blog_category,
      id: saved._id,
    };

    return res.status(201).json({ status: "ok", article });
  }

  // /api/blogs/:id
  if (blogIdMatch) {
    const _id = toObjectId(blogIdMatch[1]);
    if (!_id) return res.status(400).json({ status: "error", error: "ID inválido" });

    // GET /api/blogs/:id
    if (method === "GET") {
      const post = await blogsCollection.findOne({ _id });
      if (!post)
        return res.status(404).json({ status: "error", error: "Post não encontrado" });

      const article = {
        source: { id: null, name: "MyBlogAPI" },
        author: post.author?.toString() || "Unknown",
        title: post.blog_title,
        description: post.blog_description,
        short_description: post.blog_short_description,
        urlToImage: post.blog_image_url || "",
        publishedAt:
          toIso(post.blog_postdate) ||
          toIso(post.createdAt) ||
          toIso(post.updatedAt),
        content: post.blog_description,
        category: post.blog_category,
        id: post._id,
      };
      return res.json({ status: "ok", article });
    }

    // PUT /api/blogs/:id
    if (method === "PUT") {
      const updateData = { ...(body || {}), updatedAt: new Date() };
      if (updateData.blog_postdate)
        updateData.blog_postdate = new Date(updateData.blog_postdate);

      const result = await blogsCollection.findOneAndUpdate(
        { _id },
        { $set: updateData },
        { returnDocument: "after" }
      );

      if (!result)
        return res.status(404).json({ status: "error", error: "Post não encontrado" });

      const post = result.value ?  result.value : {}   ;
      const article = {
        source: { id: null, name: "MyBlogAPI" },
        author: post.author?.toString() || "Unknown",
        title: post.blog_title,
        description: post.blog_description,
        short_description: post.blog_short_description,
        urlToImage: post.blog_image_url || "",
        publishedAt:
          toIso(post.blog_postdate) ||
          toIso(post.createdAt) ||
          toIso(post.updatedAt),
        content: post.blog_description,
        category: post.blog_category,
        id: post._id,
      };
      return res.json({ status: "ok", article });
    }

    // DELETE /api/blogs/:id
    if (method === "DELETE") {
      const del = await blogsCollection.deleteOne({ _id });
      if (!del.deletedCount)
        return res.status(404).json({ status: "error", error: "Post não encontrado" });
      return res.json({ status: "ok", message: "Post removido com sucesso" });
    }
  }

  // Método/path não suportado
  return res.status(405).json({ error: "Método não permitido" });
}

// Opcional: desativa o bodyParser do Next caso precises de raw body (não é o caso)
// export const config = { api: { bodyParser: true } };
