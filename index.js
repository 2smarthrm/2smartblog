const express = require("express");
const mongoose = require("mongoose");

const app = express();
const PORT = 3000;

// URL do MongoDB (substitua pelos seus dados)
const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/blog_db?retryWrites=true&w=majority";

// Conecta ao MongoDB usando Mongoose
mongoose.connect(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const db = mongoose.connection;

db.on("error", (err) => {
  console.error("Erro ao conectar com o MongoDB:", err);
});

db.once("open", () => {
  console.log("Conexão com MongoDB bem-sucedida!");
});

// Rota GET simples para verificar conexão
app.get("/", (req, res) => {
  if (db.readyState === 1) { // 1 = conectado
    res.send("Conexão com MongoDB bem-sucedida!");
  } else {
    res.status(500).send("Não foi possível conectar ao MongoDB.");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
