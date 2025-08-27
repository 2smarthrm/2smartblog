 

// api/index.js
import { MongoClient } from "mongodb";

// Variável global para reutilizar conexão no serverless
let client;
let clientPromise;


const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";
// Conexão MongoDB
if (!global._mongoClientPromise) {
  client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

// Função handler para Vercel
export default async function handler(req, res) {
  // Apenas GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const client = await clientPromise;
    const db = client.db("blog_db");
    const blogs = await db.collection("blogs")
      .find()
      .sort({ blog_postdate: -1 })
      .toArray();

    // Retorna todos os blogs
    res.status(200).json(blogs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar blogs" });
  }
}
