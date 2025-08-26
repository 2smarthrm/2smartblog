 const express = require("express");
const mongoose = require("mongoose");

const app = express();
const PORT = 3000;

const uri = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net";

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB conectado com sucesso!"))
  .catch(err => console.error("Erro ao conectar ao MongoDB:", err));

app.get("/", (req, res) => {
  res.send(mongoose.connection.readyState === 1 
    ? "Conexão com MongoDB bem-sucedida!" 
    : "Não foi possível conectar ao MongoDB.");
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
