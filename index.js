const express = require("express");
const mysql = require("mysql2/promise"); // Usando mysql2 com Promises

const app = express();
const PORT = 3000;

// Configuração da conexão MySQL
const dbConfig = {
  host: "sql7.freesqldatabase.com",
  user: "sql7796211",
  password: "2zJ!=1Sy78&K",
  database: "sql7796211"
};

let connection;

// Função para conectar ao banco
async function connectToDatabase() {
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log("MySQL conectado com sucesso!");
  } catch (err) {
    console.error("Erro ao conectar ao MySQL:", err);
  }
}

// Rota principal para testar conexão
app.get("/", async (req, res) => {
  try {
    const [rows] = await connection.query("SELECT 1 + 1 AS resultado");
    res.send(`Conexão com MySQL bem-sucedida! Teste: 1 + 1 = ${rows[0].resultado}`);
  } catch (err) {
    res.send("Não foi possível conectar ao MySQL.");
  }
});

// Inicia o servidor e conecta ao banco
app.listen(PORT, async () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  await connectToDatabase();
});
