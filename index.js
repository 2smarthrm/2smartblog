const express = require("express");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = 3000;

// URL do MongoDB
const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";

const client = new MongoClient(uri);

app.get("/", async (req, res) => {
  try {
    await client.connect();
    // Testa a conexão com o comando ping
    await client.db("admin").command({ ping: 1 });
    res.send("Conexão com MongoDB bem-sucedida!");
  } catch (err) {
    res.status(500).send("Falha ao conectar com o MongoDB: " + err.message);
  } finally {
    await client.close();
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

