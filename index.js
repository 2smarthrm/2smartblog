 const express = require("express");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const session = require("express-session");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss-clean");
const hpp = require("hpp");
const rateLimit = require("express-rate-limit");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();

app.use(express.json());
app.use(cors({
  origin: "http://127.0.0.1:5500",
  credentials: true
}));
app.use(helmet()); 
app.use(hpp());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })); 
 
app.use(session({ 
  secret: "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const PORT = 3000; 

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let usersCollection;
let blogsCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("blog_db");
  usersCollection = db.collection("users");
  blogsCollection = db.collection("blogs");
}
connectDB();

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Não autenticado" });
  next();
}

app.post("/api/auth/register", async (req, res) => {
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
  const user = await usersCollection.findOne(
    { _id: new ObjectId(req.session.userId) },
    { projection: { password: 0 } }
  );
  res.json(user);
});

app.post("/api/blogs", auth, async (req, res) => {
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
    content: blog.blog_description  ,
    category:blog.blog_category
  }));

  res.json({
    status: "ok",
    totalResults: total,
    articles
  });
});



app.get("/api/blogs/:id", async (req, res) => {
  try {
    console.log("ID DO POST = ", req.params.id);
    const post = await blogsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!post) return res.status(404).json({ error: "Post não encontrado" });
    res.json(post);
  } catch {
    res.status(400).json({ error: "ID inválido" });
  }
});

app.put("/api/blogs/:id",   async (req, res) => {
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
    console.log(error)
    res.status(400).json({ error: "Erro ao atualizar" });
  }
});

app.delete("/api/blogs/:id", async (req, res) => {
  try {
    const result = await blogsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Post não encontrado" });
    res.json({ message: "Post removido com sucesso" });
  } catch {
    res.status(400).json({ error: "Erro ao remover" });
  }
});


const examplePosts = [
  {
    blog_title: "Controle de Assiduidade dos Funcionários",
    blog_short_description: "Saiba como melhorar a assiduidade e pontualidade na sua empresa.",
    blog_description: `
      <h2>Controle de Assiduidade</h2>
      <p>O controle de assiduidade é fundamental para garantir a eficiência e disciplina no ambiente de trabalho.</p>
      <ul>
        <li><b>Monitoramento diário</b> das presenças</li>
        <li><b>Relatórios automáticos</b> de faltas e atrasos</li>
        <li>Integração com sistemas de folha de pagamento</li>
      </ul>
      <p>Com um sistema automatizado, gestores conseguem acompanhar em tempo real o comportamento dos colaboradores.</p>
    `,
    blog_category: "Gestão de Desempenho",
    blog_image_url: "https://factorialhr.pt/wp-content/uploads/2020/11/23172419/controlo-de-assiduidade-teletrabalho.jpg",
    blog_postdate: "2025-08-14"
  },
  {
    blog_title: "Geofencing: Tecnologia para Gestão de Ponto",
    blog_short_description: "Descubra como o geofencing pode revolucionar o registro de ponto.",
    blog_description: `
      <h2>Geofencing</h2>
      <p>O <strong>geofencing</strong> utiliza coordenadas GPS para delimitar áreas virtuais onde o registro de ponto é permitido.</p>
      <p>Benefícios:</p>
      <ol>
        <li>Evita registros fora do local de trabalho</li>
        <li>Maior segurança nas informações</li>
        <li>Redução de fraudes no controle de jornada</li>
      </ol>
      <p>Com o geofencing, as empresas têm um controle mais rigoroso e preciso sobre a presença dos colaboradores.</p>
    `,
    blog_category: "Segurança do Trabalho",
    blog_image_url: "https://www.sesamehr.pt/wp-content/uploads/2024/05/isencao-horario.webp",
    blog_postdate: "2025-08-14"
  },
  {
    blog_title: "Presença e Terminais de Ponto Inteligentes",
    blog_short_description: "O futuro dos terminais de ponto e presença dos colaboradores.",
    blog_description: `
      <h2>Terminais de Ponto</h2>
      <p>Os novos <em>terminais de ponto inteligentes</em> oferecem integração total com sistemas de RH e folha de pagamento.</p>
      <p>Recursos avançados incluem:</p>
      <ul>
        <li>Reconhecimento facial</li>
        <li>Leitura biométrica ultrarrápida</li>
        <li>Integração com aplicativos móveis</li>
      </ul>
      <p>Esses terminais reduzem custos operacionais e aumentam a precisão no registro de jornada.</p>
    `,
    blog_category: "Tecnologia",
    blog_image_url: "",
    blog_postdate: "2025-08-14"
  }
];



async function insertSamplePosts(posts) {
  if (!blogsCollection) {
    console.error("Banco ainda não conectado.");
    return;
  }

  try {
    const result = await blogsCollection.insertMany(
      posts.map(p => ({
        ...p,
        blog_postdate: p.blog_postdate ? new Date(p.blog_postdate) : new Date(),
        author: new ObjectId("000000000000000000000000"), // ID fake ou de um admin existente
        createdAt: new Date(),
        updatedAt: new Date()
      }))
    );
    console.log(`${result.insertedCount} posts inseridos com sucesso.`);
  } catch (err) {
    console.error("Erro ao inserir posts:", err);
  }
}
 
async function startServer() {
  await connectDB(); // só continua quando o Mongo conectar

  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

startServer();
