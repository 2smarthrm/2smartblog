const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const Cors   = require("cors");
const cookie = require("cookie");
const jwt    = require("jsonwebtoken");
const http   = require("http");
const nodemailer = require("nodemailer");
const formidable = require('formidable');
const fs   = require('fs');
const path = require('path');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ImageKitModule = require('imagekit');
const ImageKitClass  = ImageKitModule.default || ImageKitModule;
const imagekit = new ImageKitClass({
  publicKey:   'public_X40KBDYHT8F5/LPw1IJX1s6K62Q=',
  privateKey:  'private_jun/amOWn37j6Pf6aboTA1dhgZs=',
  urlEndpoint: 'https://ik.imagekit.io/fsobpyaa5i',
});

const Database = require('better-sqlite3');
const crypto   = require('crypto');

// ============================================================================
// SESSION STORE — SQLite via better-sqlite3
// ============================================================================
const SESSION_DB_FILE  = path.join(__dirname, 'sessions.db');
const SESSION_MAX_AGE  = 60 * 60 * 24 * 7; // 7 dias em segundos
const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000; // limpeza a cada hora

let _sessDb, _stmtInsert, _stmtGet, _stmtRenew, _stmtDelete, _stmtCleanup, _stmtList;
let _sessBackend = 'sqlite'; // 'sqlite' ou 'memory'

try {
  _sessDb = new Database(SESSION_DB_FILE);
  _sessDb.pragma('journal_mode = WAL');
  _sessDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT,
      email      TEXT,
      role       TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  _stmtInsert  = _sessDb.prepare('INSERT OR REPLACE INTO sessions (id, user_id, name, email, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  _stmtGet     = _sessDb.prepare('SELECT * FROM sessions WHERE id = ?');
  _stmtRenew   = _sessDb.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?');
  _stmtDelete  = _sessDb.prepare('DELETE FROM sessions WHERE id = ?');
  _stmtCleanup = _sessDb.prepare('DELETE FROM sessions WHERE expires_at < ?');
  _stmtList    = _sessDb.prepare('SELECT * FROM sessions');

  // Teste rápido de escrita/leitura
  const _testId = '__test__';
  _stmtInsert.run(_testId, 'test', 'test', 'test', 'test', Date.now(), Date.now() + 5000);
  const _testRow = _stmtGet.get(_testId);
  _stmtDelete.run(_testId);
  if (!_testRow) throw new Error('Leitura imediata após escrita devolveu null');

  // Confirma tabela e teste r/w
  const _tables = _sessDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  process.stdout.write(`[SESSION] ✅ SQLite OK — ${SESSION_DB_FILE}\n`);
  process.stdout.write(`[SESSION]    tabelas   : ${_tables.map(t=>t.name).join(', ')}\n`);
  process.stdout.write(`[SESSION]    teste r/w : ${_testRow ? '✅ OK' : '❌ falhou'}\n`);

  // Insere registo de teste permanente e lê-o de volta
  const _diagId = 'diag-startup-test';
  const _diagNow = Date.now();
  _stmtInsert.run(_diagId, '000000000000000000000000', 'Teste Arranque', 'teste@2smart.pt', 'test', _diagNow, _diagNow + 999999999);
  const _diagRow = _stmtGet.get(_diagId);
  const _countAfter = _sessDb.prepare("SELECT COUNT(*) as n FROM sessions").get();
  process.stdout.write(`[SESSION]    registo de teste inserido:\n`);
  process.stdout.write(`[SESSION]      id        : ${_diagRow?.id}\n`);
  process.stdout.write(`[SESSION]      user_id   : ${_diagRow?.user_id}\n`);
  process.stdout.write(`[SESSION]      name      : ${_diagRow?.name}\n`);
  process.stdout.write(`[SESSION]      email     : ${_diagRow?.email}\n`);
  process.stdout.write(`[SESSION]      role      : ${_diagRow?.role}\n`);
  process.stdout.write(`[SESSION]      leitura   : ${_diagRow ? '✅ lido com sucesso' : '❌ null — escrita falhou'}\n`);
  process.stdout.write(`[SESSION]    total sessões na BD: ${_countAfter.n}\n`);
} catch (err) {
  process.stderr.write(`[SESSION] ❌ SQLite falhou: ${err.message}\n`);
  process.stderr.write(`[SESSION] ⚠️  A usar fallback em memória (sessões perdem-se ao reiniciar)\n`);
  _sessBackend = 'memory';
  _sessDb = null;
}

// Fallback em memória
const _memSessions = {};

function sessionCreate(userId, meta = {}) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now       = Date.now();
  const expiresAt = now + SESSION_MAX_AGE * 1000;
  if (_sessBackend === 'sqlite') {
    try {
      _stmtInsert.run(sessionId, String(userId), meta.name||null, meta.email||null, meta.role||null, now, expiresAt);
      process.stdout.write(`[SESSION] CREATE sqlite sid=${sessionId.substring(0,16)}… uid=${userId}\n`);
    } catch(e) {
      process.stderr.write(`[SESSION] INSERT falhou: ${e.message} — a usar memória\n`);
      _memSessions[sessionId] = { userId: String(userId), ...meta, createdAt: now, expiresAt };
    }
  } else {
    _memSessions[sessionId] = { userId: String(userId), ...meta, createdAt: now, expiresAt };
    process.stdout.write(`[SESSION] CREATE memory sid=${sessionId.substring(0,16)}… uid=${userId}\n`);
  }
  return sessionId;
}

function sessionGet(sessionId) {
  if (!sessionId) return null;
  if (_sessBackend === 'sqlite') {
    try {
      const row = _stmtGet.get(sessionId);
      if (!row) { process.stdout.write(`[SESSION] GET not found sid=${sessionId.substring(0,16)}…\n`); return null; }
      if (Date.now() > row.expires_at) { _stmtDelete.run(sessionId); return null; }
      return { userId: row.user_id, name: row.name, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at };
    } catch(e) {
      process.stderr.write(`[SESSION] GET falhou: ${e.message}\n`);
      return null;
    }
  } else {
    const s = _memSessions[sessionId];
    if (!s) return null;
    if (Date.now() > s.expiresAt) { delete _memSessions[sessionId]; return null; }
    return s;
  }
}

function sessionRenew(sessionId) {
  if (!sessionId) return;
  if (_sessBackend === 'sqlite') {
    try { _stmtRenew.run(Date.now() + SESSION_MAX_AGE * 1000, sessionId); } catch(e) {}
  } else if (_memSessions[sessionId]) {
    _memSessions[sessionId].expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  }
}

function sessionDestroy(sessionId) {
  if (!sessionId) return;
  if (_sessBackend === 'sqlite') {
    try { _stmtDelete.run(sessionId); } catch(e) {}
  } else {
    delete _memSessions[sessionId];
  }
}

function sessionCleanup() {
  if (_sessBackend === 'sqlite') {
    try { _stmtCleanup.run(Date.now()); } catch(e) {}
  } else {
    const now = Date.now();
    for (const [id, s] of Object.entries(_memSessions)) {
      if (now > s.expiresAt) delete _memSessions[id];
    }
  }
}

function sessionsRead() {
  if (_sessBackend === 'sqlite') {
    try { return _stmtList.all(); } catch(e) { return []; }
  }
  return Object.entries(_memSessions).map(([id, s]) => ({ id, user_id: s.userId, name: s.name, email: s.email, role: s.role, created_at: s.createdAt, expires_at: s.expiresAt }));
}

// Limpeza periódica automática
setInterval(sessionCleanup, SESSION_CLEANUP_INTERVAL);
sessionCleanup();

// ============================================================================


function buildRoiEmailHtml({ userName, calcData }) {
  const d = calcData; 

  function fmtEur(v) {
    return new Intl.NumberFormat("pt-PT", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 2,
    }).format(v);
  }

  const PROCESSOS = [
    { key: "horarios", label: "Controlo de horários e registos de ponto",               reducao: 0.50 },
    { key: "ferias",   label: "Gestão de férias e ausências",                           reducao: 0.55 },
    { key: "salarios", label: "Processamento de salários",                              reducao: 0.60 },
    { key: "onboard",  label: "Integração de novos colaboradores",                      reducao: 0.50 },
    { key: "docs",     label: "Gestão documental (contratações, rescisões, contratos)", reducao: 0.55 },
    { key: "dados",    label: "Controlo e atualização de dados dos colaboradores",      reducao: 0.65 },
    { key: "comms",    label: "Comunicação interna (e-mails, avisos, lembretes)",       reducao: 0.60 },
    { key: "relat",    label: "Elaboração de relatórios",                               reducao: 0.70 },
    { key: "aval",     label: "Avaliação de desempenho",                                reducao: 0.45 },
  ];

  const tableRows = PROCESSOS.map((p, i) => {
    const bg = i % 2 === 1 ? "background:#f4f7fc;" : "";
    return `
      <tr style="${bg}">
        <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">${p.label}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;text-align:center;">${d.horasAt[i].toFixed(1)} h</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;text-align:center;">${d.horasCom[i].toFixed(1)} h</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#16a34a;text-align:center;">${Math.round(p.reducao * 100)}%</td>
      </tr>`;
  }).join("");

  const totSavingPct = d.totAt > 0 ? Math.round(((d.totAt - d.totCom) / d.totAt) * 100) : 0;

  return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="pt">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resultados da Calculadora ROI — 2Smart HR</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background-color: #f2f2f2; font-family: Helvetica Neue, Helvetica, Arial, sans-serif; }
    @media (max-width: 600px) {
      .container { width: 100% !important; }
      .kpi-table td { display: block !important; width: 100% !important; }
    }
  </style>
</head>
<body style="background-color:#f2f2f2;margin:0;padding:0;">

  <!-- TOP BAR -->
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td>
        <table class="container" align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
               style="background-color:#2261dd;margin:0 auto;width:675px;">
          <tr>
            <td style="padding:8px 20px;text-align:center;">
              <p style="margin:0;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:3px;line-height:1.5;">
                Software de gestão de assiduidades e recursos humanos
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table> 
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td>
        <table class="container" align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
               style="background-color:#ffffff;margin:0 auto;width:675px;">
          <tr>
            <td style="padding:30px 40px 0;">

              <!-- LOGO -->
              <div style="text-align:center;margin-bottom:20px;">
                <img src="https://ik.imagekit.io/fsobpyaa5i/Ativo%208%20(2).png" alt="2Smart HR" style="height:36px;display:inline-block;">
              </div>

              <!-- SUBTITLE -->
              <p style="margin:0 0 6px;color:#2261dd;font-size:13px;font-weight:700;letter-spacing:3px;text-align:center;text-transform:uppercase;">
                Calculadora de ROI gratuita
              </p>

              <!-- TITLE -->
              <h1 style="margin:0 0 6px;color:#152648;font-size:26px;font-weight:700;text-align:center;line-height:1.2;">
                Os seus resultados <span style="color:#2261dd;">ROI</span>
              </h1>
              <p style="margin:0 0 24px;color:#5a6c87;font-size:14px;text-align:center;line-height:1.6;">
                Olá <strong>${userName}</strong>, aqui estão as estimativas de poupança para a sua empresa com o 2Smart HR.
              </p>

              <!-- KPI CARDS -->
              <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;">
                <tr>
                  <td width="25%" style="padding:4px;">
                    <div style="background:#f4f7fc;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #e0e7f0;">
                      <div style="font-size:10px;font-weight:700;color:#7a8fa8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Poupança mensal</div>
                      <div style="font-size:20px;font-weight:900;color:#152648;margin-bottom:2px;">${fmtEur(d.poupMensal)}</div>
                      <div style="font-size:10px;color:#9ca3b8;">Automatização</div>
                    </div>
                  </td>
                  <td width="25%" style="padding:4px;">
                    <div style="background:linear-gradient(135deg,#2261dd,#0040cc);border-radius:10px;padding:14px 10px;text-align:center;">
                      <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,.8);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Poupança anual</div>
                      <div style="font-size:20px;font-weight:900;color:#ffffff;margin-bottom:2px;">${fmtEur(d.poupAnual)}</div>
                      <div style="font-size:10px;color:rgba(255,255,255,.7);">Projeção 12 meses</div>
                    </div>
                  </td>
                  <td width="25%" style="padding:4px;">
                    <div style="background:#f4f7fc;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #e0e7f0;">
                      <div style="font-size:10px;font-weight:700;color:#7a8fa8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">ROI calculado</div>
                      <div style="font-size:20px;font-weight:900;color:#2261dd;margin-bottom:2px;">${Math.round(d.roi)}%</div>
                      <div style="font-size:10px;color:#9ca3b8;">Retorno</div>
                    </div>
                  </td>
                  <td width="25%" style="padding:4px;">
                    <div style="background:#f4f7fc;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #e0e7f0;">
                      <div style="font-size:10px;font-weight:700;color:#7a8fa8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Recuperação</div>
                      <div style="font-size:20px;font-weight:900;color:#152648;margin-bottom:2px;">${d.payback} ${d.payback === 1 ? "mês" : "meses"}</div>
                      <div style="font-size:10px;color:#9ca3b8;">Payback</div>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- INPUTS SUMMARY -->
              <div style="background:#f8fafd;border-radius:10px;padding:16px 18px;margin-bottom:24px;border:1px solid #e0e7f0;">
                <div style="font-size:11px;font-weight:800;color:#2261dd;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Dados utilizados no cálculo</div>
                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                  <tr>
                    <td style="font-size:12px;color:#5a6c87;padding:3px 0;width:50%;">
                       I-  <strong>${d.numColab}</strong> colaboradores
                    </td>
                    <td style="font-size:12px;color:#5a6c87;padding:3px 0;width:50%;">
                      II - <strong>${d.numRH}</strong> pessoas em RH
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:12px;color:#5a6c87;padding:3px 0;">
                      III -  Custo RH: <strong>${fmtEur(d.custoHora)}/hora</strong>
                    </td>
                    <td style="font-size:12px;color:#5a6c87;padding:3px 0;">
                      IV -  ${d.planoLabel}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:12px;color:#5a6c87;padding:3px 0;">
                      V - Custo mensal: <strong>${fmtEur(d.custoMes)}</strong>
                    </td>
                    <td style="font-size:12px;color:#5a6c87;padding:3px 0;">
                      VI - Custo anual: <strong>${fmtEur(d.custoAno)}</strong>
                    </td>
                  </tr>
                  ${d.setor ? `<tr><td colspan="2" style="font-size:12px;color:#5a6c87;padding:3px 0;">VII Setor: <strong>${d.setor}</strong></td></tr>` : ""}
                </table>
              </div>

              <!-- PROCESS TABLE -->
              <div style="font-size:11px;font-weight:800;color:#2261dd;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e0e7f0;">
                Poupança por processo
              </div>
              <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;border-collapse:collapse;">
                <thead>
                  <tr style="background:#f0f6ff;">
                    <th style="padding:8px 10px;font-size:11px;font-weight:800;color:#1a3a6b;text-align:left;text-transform:uppercase;letter-spacing:.5px;">Processo</th>
                    <th style="padding:8px 10px;font-size:11px;font-weight:800;color:#1a3a6b;text-align:center;text-transform:uppercase;letter-spacing:.5px;">Atual (h/sem)</th>
                    <th style="padding:8px 10px;font-size:11px;font-weight:800;color:#1a3a6b;text-align:center;text-transform:uppercase;letter-spacing:.5px;">2Smart (h/sem)</th>
                    <th style="padding:8px 10px;font-size:11px;font-weight:800;color:#1a3a6b;text-align:center;text-transform:uppercase;letter-spacing:.5px;">Poupança</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableRows}
                  <tr style="background:#2261dd;">
                    <td style="padding:8px 10px;font-size:12px;font-weight:800;color:#fff;">Totais</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:800;color:#fff;text-align:center;">${d.totAt.toFixed(1)} h</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:800;color:#fff;text-align:center;">${d.totCom.toFixed(1)} h</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:800;color:#fff;text-align:center;">${totSavingPct}%</td>
                  </tr>
                </tbody>
              </table>

              <!-- FINANCIAL SUMMARY -->
              <div style="font-size:11px;font-weight:800;color:#2261dd;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e0e7f0;">
                Resumo financeiro
              </div>
              <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;border-collapse:collapse;">
                <tr>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Custo 2Smart (mensal)</td>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#374151;text-align:right;">${fmtEur(d.custoMes)}</td>
                </tr>
                <tr style="background:#f4f7fc;">
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Custo 2Smart (anual)</td>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#374151;text-align:right;">${fmtEur(d.custoAno)}</td>
                </tr>
                <tr>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Poupança mensal estimada</td>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:800;color:#16a34a;text-align:right;">${fmtEur(d.poupMensal)}</td>
                </tr>
                <tr style="background:#f4f7fc;">
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Poupança anual estimada</td>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:800;color:#16a34a;text-align:right;">${fmtEur(d.poupAnual)}</td>
                </tr>
                <tr>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">ROI calculado</td>
                  <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:800;color:#2261dd;text-align:right;">${Math.round(d.roi)}%</td>
                </tr>
                <tr style="background:#f4f7fc;">
                  <td style="padding:7px 10px;font-size:12px;color:#374151;">Tempo de recuperação</td>
                  <td style="padding:7px 10px;font-size:12px;font-weight:800;color:#374151;text-align:right;">${d.payback} ${d.payback === 1 ? "mês" : "meses"}</td>
                </tr>
              </table> 
              <!-- CTA BUTTON -->
              <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="padding:0 0 30px;text-align:center;">
                    <a href="https://2smart.pt/request-information.html" target="_blank"
                       style="background-color:#2261dd;color:#ffffff;display:inline-block;font-size:15px;font-weight:600;
                              text-decoration:none;padding:14px 36px;border-radius:6px;letter-spacing:.3px;">
                      ↪ Agende uma demonstração gratuita agora
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- FOOTER -->
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td>
        <table class="container" align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
               style="background-color:#092a69;margin:0 auto;width:675px;">
          <tr>
            <td style="padding:30px 40px;">
              <!-- LOGO WHITE -->
              <div style="text-align:center;margin-bottom:14px;">
                <img src="https://media.beefree.cloud/pub/bfra/cu1zp9r2/fve/0lo/kgp/logo-2smart-17%20%281%29%20%282%29.png"
                     alt="2Smart HR" style="height:32px;display:inline-block;">
              </div>
              <!-- DESCRIPTION -->
              <p style="margin:0 0 16px;color:rgba(255,255,255,.8);font-size:13px;text-align:center;line-height:1.6;padding:0 20px;">
                A Plataforma Cloud com Portal de Colaborador integrada e dotada de IA que o ajuda a gerir eficientemente os seus RH.
                Centralize a gestão da força de trabalho num só sistema: controle assiduidade, organize turnos e escalas e analise métricas.
              </p>
              <!-- SOCIAL ICONS -->
              <div style="text-align:center;margin-bottom:16px;">
                <a href="https://www.linkedin.com/company/2smart-hr/" target="_blank" style="display:inline-block;margin:0 4px;">
                  <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/linkedin@2x.png"
                       width="28" height="28" alt="LinkedIn" style="display:block;">
                </a>
                <a href="https://www.youtube.com/@2Smarthr" target="_blank" style="display:inline-block;margin:0 4px;">
                  <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/youtube@2x.png"
                       width="28" height="28" alt="YouTube" style="display:block;">
                </a>
                <a href="https://2smart.pt/" target="_blank" style="display:inline-block;margin:0 4px;">
                  <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/website@2x.png"
                       width="28" height="28" alt="Website" style="display:block;">
                </a>
              </div>
              <!-- DISCLAIMER -->
              <p style="margin:0;color:rgba(255,255,255,.4);font-size:10px;text-align:center;line-height:1.6;">
                Os valores apresentados são estimativas indicativas. Resultados reais podem variar consoante a dimensão, setor e processos de cada organização.<br>
                © 2Smart HR · <a href="https://2smart.pt" style="color:rgba(255,255,255,.6);text-decoration:none;">www.2smart.pt</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}


const MONGODB_URI = "mongodb+srv://2smarthr:123XPLO9575V2SMART@cluster0.znogkav.mongodb.net/?retryWrites=true&w=majority";
const DB_NAME = process.env.MONGODB_DB        || "blog_db";
const JWT_SECRET   = process.env.JWT_SECRET        || "CHANGE_ME_SUPER_SECRET";
const COOKIE_NAME  = process.env.AUTH_COOKIE_NAME  || "sid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const PORT = process.env.PORT || 4000;
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000",
  "http://localhost:4000",
  "https://2smart.pt", 
  "https://2smsite.vercel.app",
  "https://2smartblog.exportech.com.pt", 
  "https://blogsmart.vercel.app",
  "https://crm.2smart.pt",
  "https://crm.2smart.pt",
  "www.crm.2smart.pt",
];

const transporter = nodemailer.createTransport({
  service: "Gmail",
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: "2smarthrm@gmail.com", pass: "bguvbniphmcnxdrl" },
});

const cors = Cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

function runCors(req, res) {
  return new Promise((resolve, reject) =>
    cors(req, res, (r) => (r instanceof Error ? reject(r) : resolve(r)))
  );
}

function setCorsEchoHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
}

let client, clientPromise;
let usersCollection, blogsCollection, newsletterCollection;
let proposalsCollection, leadsCollection, contactosCollection, reunioesCollection;
let custosCollection, pipelineConfigCollection, pipelineOrderCollection;
let partnershipsCollection;

async function getDb() {
  if (!clientPromise) {
    client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect();
  }
  const conn = await clientPromise;
  const db = conn.db(DB_NAME);
  usersCollection          = usersCollection          || db.collection("users");
  blogsCollection          = blogsCollection          || db.collection("blogs");
  newsletterCollection     = newsletterCollection     || db.collection("newsletter");
  proposalsCollection      = proposalsCollection      || db.collection("proposals");
  leadsCollection          = leadsCollection          || db.collection("leads");
  contactosCollection      = contactosCollection      || db.collection("contactos");
  reunioesCollection       = reunioesCollection       || db.collection("reunioes");
  custosCollection         = custosCollection         || db.collection("custos");
  pipelineConfigCollection = pipelineConfigCollection || db.collection("pipeline_configs");
  pipelineOrderCollection  = pipelineOrderCollection  || db.collection('pipeline_orders');
  partnershipsCollection   = partnershipsCollection   || db.collection("partnerships");
  return db;
}

function toObjectId(id) {
  try { return new ObjectId(id); } catch { return null; }
}

function toIso(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Cookie helpers — agora usam sessionId em vez de JWT
// ---------------------------------------------------------------------------

/**
 * Lê o sessionId do cookie e devolve os dados da sessão (ou null).
 */
function readSessionFromReq(req) {
  // 1. Tenta Bearer token no header Authorization (funciona cross-origin sem cookies)
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const sessionId = authHeader.slice(7).trim();
    if (sessionId) {
      const data = sessionGet(sessionId);
      process.stdout.write(`[AUTH] Bearer: sid=${sessionId.substring(0,16)}… → ${data ? '✅ ' + data.name : '❌ não encontrado'}\n`);
      return { sessionId, data };
    }
  }

  // 2. Fallback: cookie (funciona quando mesmo domínio)
  const parsed    = cookie.parse(req.headers.cookie || '');
  const sessionId = parsed[COOKIE_NAME];
  if (sessionId) {
    const data = sessionGet(sessionId);
    process.stdout.write(`[AUTH] Cookie: sid=${sessionId.substring(0,16)}… → ${data ? '✅ ' + data.name : '❌ não encontrado'}\n`);
    return { sessionId, data };
  }

  process.stdout.write(`[AUTH] Sem sessão (sem Bearer nem cookie sid)\n`);
  return { sessionId: null, data: null };
}

// Cookie cross-origin: sameSite=none obrigatório para funcionar entre
// frontend (porta 5500) e backend (porta 4000) ou domínios diferentes.
// secure é detectado dinamicamente: true se o pedido vier de HTTPS, false em HTTP.
// Assim funciona tanto em localhost (HTTP) como em produção (HTTPS) sem mudar nada.

function _isSecureRequest(req) {
  // X-Forwarded-Proto definido por proxies/nginx em produção
  if (req.headers['x-forwarded-proto'] === 'https') return true;
  // Origin do pedido começa com https
  const origin = req.headers['origin'] || '';
  if (origin.startsWith('https://')) return true;
  // Referer começa com https
  const referer = req.headers['referer'] || '';
  if (referer.startsWith('https://')) return true;
  return false;
}

function setSessionCookie(res, sessionId, req) {
  const secure   = _isSecureRequest(req);
  // sameSite=none exige secure=true (browsers modernos rejeitam none+insecure)
  // Em HTTP (localhost) usamos lax que funciona same-site mas não cross-site
  const sameSite = secure ? "none" : "lax";
  const serialized = cookie.serialize(COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  res.setHeader("Set-Cookie", serialized);
  process.stdout.write(`[AUTH] Set-Cookie: ${COOKIE_NAME}=${sessionId.substring(0,16)}… secure=${secure} sameSite=${sameSite}\n`);
}

function clearSessionCookie(res, req) {
  const secure   = req ? _isSecureRequest(req) : false;
  const sameSite = secure ? "none" : "lax";
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, "", {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    expires: new Date(0),
  }));
}

// Mantém compatibilidade com o código legado que usa signToken / JWT
// (podem existir clientes antigos com o cookie "token" — fazemos fallback)
function signToken(userId) {
  return jwt.sign({ uid: String(userId) }, JWT_SECRET, { expiresIn: "7d" });
}

function readTokenFromReq(req) {
  const parsed = cookie.parse(req.headers.cookie || "");
  const tok    = parsed["token"]; // cookie legado
  if (!tok) return null;
  try { return jwt.verify(tok, JWT_SECRET); } catch { return null; }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { 
        resolve(data ? JSON.parse(data) : {});
      } catch(err){
        resolve({});
      }
    });
    req.on("error", reject);
  });
} 

function buildRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (obj)  => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };
  res.end = res.end.bind(res);
  return res;
}

/**
 * Verifica autenticação usando a nova sessão em ficheiro.
 * Faz fallback para o JWT legado caso o cookie "token" ainda esteja presente.
 */
async function requireAuthUser(req, res) {
  // --- Nova sessão ---
  const { sessionId, data: sessData } = readSessionFromReq(req);
  if (sessionId && sessData) {
    const _id  = toObjectId(sessData.userId);
    if (!_id) { res.status(401).json({ error: "Sessão inválida" }); return null; }
    const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
    if (!user)              { res.status(401).json({ error: "Utilizador não encontrado" }); return null; }
    if (user.active === false) { res.status(403).json({ error: "Conta desativada" }); return null; }
    // Renova expiração a cada pedido autenticado
    sessionRenew(sessionId);
    return user;
  }

  // --- Fallback JWT legado ---
  const t = readTokenFromReq(req);
  if (t?.uid) {
    const _id  = toObjectId(t.uid);
    if (!_id)  { res.status(401).json({ error: "Token inválido" }); return null; }
    const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
    if (!user) { res.status(401).json({ error: "Utilizador não encontrado" }); return null; }
    if (user.active === false) { res.status(403).json({ error: "Conta desativada" }); return null; }
    return user;
  }

  res.status(401).json({ error: "Não autenticado" });
  return null;
}

function isMaster(user)           { return user?.role === "master"; }
function isComercialMaster(user)  { return user?.role === "comercial-master"; }
function isComercial(user)        { return user?.role === "comercial"; }
function canSeeAll(user)          { return isMaster(user) || isComercialMaster(user); }
function comercialFilter(user)    { return { createdBy: String(user._id) }; }

async function uploadToImageKit(fileBuffer, fileName, mimeType) {
  const base64 = fileBuffer.toString('base64');
  const result = await imagekit.upload({
    file: base64, fileName, folder: '/pipeline-attachments', useUniqueFileName: true,
  });
  return { url: result.url, fileId: result.fileId, name: result.name, size: result.size, type: mimeType };
}

function handleError(res, endpoint, err) {
  console.error(`[ERROR] ${endpoint}:`, err);
  if (!res.writableEnded) {
    res.status(500).json({ error: "Erro interno do servidor", detail: err?.message || String(err) });
  }
}

async function handler(req, res) {
  buildRes(res);
  try { await runCors(req, res); setCorsEchoHeaders(req, res); }
  catch (err) { return res.status(403).json({ error: err.message || "CORS bloqueado" }); }

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  try { await getDb(); }
  catch (err) {
    console.error("[ERROR] getDb:", err);
    return res.status(500).json({ error: "Falha a ligar ao MongoDB", detail: err?.message });
  }

  const method   = req.method;
  const rawUrl   = req.url || "";
  const urlObj   = new URL(rawUrl, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const query    = {};
  urlObj.searchParams.forEach((v, k) => (query[k] = v));

  // ── Servir ficheiros locais ──────────────────────────────────────────────
  if (pathname.startsWith('/uploads/')) {
    try {
      const fileName = path.basename(pathname);
      const filePath = path.join(UPLOADS_DIR, fileName);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Ficheiro não encontrado' });
      const ext = path.extname(fileName).toLowerCase();
      const mimeMap = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf' };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { handleError(res, 'GET /uploads/:file', err); }
    return;
  }

  // ── Upload de anexo ──────────────────────────────────────────────────────
  if (pathname === '/api/pipeline/attachment' && method === 'POST') {
    try {
      const authUser = await requireAuthUser(req, res);
      if (!authUser) return;

      const form = new formidable.IncomingForm({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 20 * 1024 * 1024 });
      let fields, files;
      try {
        [fields, files] = await new Promise((resolve, reject) =>
          form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]))
        );
      } catch (err) {
        console.error("[ERROR] POST /api/pipeline/attachment — form.parse:", err);
        return res.status(400).json({ error: 'Erro ao processar ficheiro: ' + (err.message || 'formato inválido') });
      }

      const itemId   = Array.isArray(fields.itemId)   ? fields.itemId[0]   : fields.itemId;
      const itemType = Array.isArray(fields.itemType) ? fields.itemType[0] : fields.itemType;
      const fileArr  = files.file;
      const file     = Array.isArray(fileArr) ? fileArr[0] : fileArr;
      if (!itemId || !itemType || !file) return res.status(400).json({ error: 'itemId, itemType e file são obrigatórios' });

      const _idObj = toObjectId(itemId);
      if (!_idObj) return res.status(400).json({ error: 'itemId inválido' });

      const typeMap = {
        lead:      { col: leadsCollection,     ownerField: 'createdBy' },
        contacto:  { col: contactosCollection, ownerField: 'createdBy' },
        reuniao:   { col: reunioesCollection,  ownerField: 'createdBy' },
        proposta:  { col: proposalsCollection, ownerField: 'createdBy' },
      };
      const m = typeMap[itemType];
      if (!m) return res.status(400).json({ error: 'itemType inválido' });

      const doc = await m.col.findOne({ _id: _idObj });
      if (!doc) return res.status(404).json({ error: 'Registo não encontrado' });
      if (!canSeeAll(authUser) && doc[m.ownerField] !== String(authUser._id))
        return res.status(403).json({ error: 'Acesso negado' });

      const mimeType = file.mimetype || file.type || 'application/octet-stream';
      const allowed  = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];
      if (!allowed.includes(mimeType)) return res.status(400).json({ error: 'Tipo de ficheiro não suportado.' });

      let attachment;
      try {
        const filePath   = file.filepath || file.path;
        const fileBuffer = fs.readFileSync(filePath);
        const originalName = file.originalFilename || file.name || path.basename(filePath);
        const ikResult   = await uploadToImageKit(fileBuffer, originalName, mimeType);
        try { fs.unlinkSync(filePath); } catch(e) { console.error("[WARN] Falha ao apagar ficheiro temporário:", e); }
        attachment = { name: originalName, url: ikResult.url, type: mimeType, size: file.size || ikResult.size, uploadedAt: new Date(), uploadedBy: String(authUser._id) };
      } catch (ikErr) {
        console.error("[ERROR] POST /api/pipeline/attachment — ImageKit upload:", ikErr);
        const filePath  = file.filepath || file.path;
        const fileName  = path.basename(filePath);
        attachment = { name: file.originalFilename || file.name || fileName, url: `/uploads/${fileName}`, type: mimeType, size: file.size, uploadedAt: new Date(), uploadedBy: String(authUser._id) };
      }

      await m.col.updateOne({ _id: _idObj }, { $push: { pipelineAttachments: attachment }, $set: { updatedAt: new Date() } });
      return res.json({ status: 'ok', attachment });
    } catch (err) { return handleError(res, 'POST /api/pipeline/attachment', err); }
  }

  // ── Upload imagem de blog ────────────────────────────────────────────────
  if (pathname === "/api/blogs/upload-image" && method === "POST") {
    try { 
      const form = new formidable.IncomingForm({
        uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 10 * 1024 * 1024
      });
      let fields, files;
      try {
        [fields, files] = await new Promise((resolve, reject) =>
          form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]))
        );
      } catch (err) {
        console.error("[ERROR] POST /api/blogs/upload-image — form.parse:", err);
        return res.status(400).json({ error: "Erro ao processar ficheiro" });
      }
      const fileArr = files.file;
      const file    = Array.isArray(fileArr) ? fileArr[0] : fileArr;
      if (!file) return res.status(400).json({ error: "Ficheiro em falta" });
      const mimeType = file.mimetype || file.type || "application/octet-stream";
      const allowed  = ["image/jpeg","image/png","image/webp","image/gif"];
      if (!allowed.includes(mimeType))
        return res.status(400).json({ error: "Tipo não suportado" });
      try {
        const filePath   = file.filepath || file.path;
        const fileBuffer = fs.readFileSync(filePath);
        const origName   = file.originalFilename || file.name || path.basename(filePath);
        const ikResult   = await uploadToImageKit(fileBuffer, origName, mimeType);
        try { fs.unlinkSync(filePath); } catch(e) {}
        return res.json({ status: "ok", url: ikResult.url });
      } catch (ikErr) {
        console.error("[ERROR] POST /api/blogs/upload-image — ImageKit:", ikErr);
        const filePath = file.filepath || file.path;
        const fileName = path.basename(filePath);
        return res.json({ status: "ok", url: `/uploads/${fileName}` });
      }
    } catch (err) { return handleError(res, "POST /api/blogs/upload-image", err); }
  }

  let body;
  try { body = await parseBody(req); }
  catch (err) {
    console.error("[ERROR] parseBody:", err);
    body = {};
  }

  const blogIdMatch          = pathname.match(/^\/api\/blogs\/([\w\d]+)$/);
  const newsletterIdMatch    = pathname.match(/^\/api\/newsletter\/([\w\d]+)$/);
  const proposalIdMatch      = pathname.match(/^\/api\/proposals\/([\w\d]+)$/);
  const proposalStatusMatch  = pathname.match(/^\/api\/proposals\/([\w\d]+)\/status$/);
  const leadIdMatch          = pathname.match(/^\/api\/leads\/([\w\d]+)$/);
  const leadStatusMatch      = pathname.match(/^\/api\/leads\/([\w\d]+)\/status$/);
  const contactoIdMatch      = pathname.match(/^\/api\/contactos\/([\w\d]+)$/);
  const contactoNotasMatch   = pathname.match(/^\/api\/contactos\/([\w\d]+)\/notas$/);
  const reuniaoIdMatch       = pathname.match(/^\/api\/reunioes\/([\w\d]+)$/);
  const reuniaoStatusMatch   = pathname.match(/^\/api\/reunioes\/([\w\d]+)\/status$/);
  const custoIdMatch         = pathname.match(/^\/api\/custos\/([\w\d]+)$/);
  const userIdMatch          = pathname.match(/^\/api\/users\/([\w\d]+)$/);
  const userStatusMatch      = pathname.match(/^\/api\/users\/([\w\d]+)\/status$/);
  const userPasswordMatch    = pathname.match(/^\/api\/users\/([\w\d]+)\/password$/);
  const partnershipIdMatch   = pathname.match(/^\/api\/partnerships\/([\w\d]+)$/);

  // ============================================================================
  // AUTH
  // ============================================================================
  if (pathname === "/api/auth/register" && method === "POST") {
    try {
      const { name, email, password } = body || {};
      if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });
      const exists = await usersCollection.findOne({ email });
      if (exists) return res.status(409).json({ error: "Email já cadastrado" });
      const hash   = await bcrypt.hash(password, 10);
      const result = await usersCollection.insertOne({ name, email, password: hash, role: "comercial", active: true, createdAt: new Date() });
      return res.status(201).json({ id: result.insertedId, name, email, createdAt: new Date() });
    } catch (err) { return handleError(res, 'POST /api/auth/register', err); }
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    try {
      const { email, password } = body || {};
      process.stdout.write(`\n[LOGIN] body: email=${email} pass=${password?'***':'VAZIO'}\n`);
      if (!email || !password) {
        process.stdout.write('[LOGIN] REJEITADO campos em falta\n');
        return res.status(400).json({ error: "Campos obrigatórios" });
      }
      const user = await usersCollection.findOne({ email });
      process.stdout.write(`[LOGIN] user na BD: ${user ? user.email : 'NULL - nao existe'}\n`);
      if (!user || !(await bcrypt.compare(password, user.password))) {
        process.stdout.write('[LOGIN] REJEITADO credenciais invalidas\n');
        return res.status(401).json({ error: "Credenciais inválidas" });
      }
      if (user.active === false) return res.status(403).json({ error: "Conta desativada" });

      // Cria sessão persistente em ficheiro
      const sessionId = sessionCreate(String(user._id), {
        name:  user.name,
        email: user.email,
        role:  user.role,
      });
      setSessionCookie(res, sessionId, req);

      // ── Debug login ──────────────────────────────────────────────────
      const dbSession = sessionGet(sessionId);
      process.stdout.write("\n\x1b[42m\x1b[30m ✔ LOGIN OK \x1b[0m\n");
      process.stdout.write(`  sessionId : ${sessionId}\n`);
      process.stdout.write(`  userId    : ${dbSession?.userId}\n`);
      process.stdout.write(`  name      : ${dbSession?.name}\n`);
      process.stdout.write(`  email     : ${dbSession?.email}\n`);
      process.stdout.write(`  role      : ${dbSession?.role}\n`);
      process.stdout.write(`  expiresAt : ${dbSession ? new Date(dbSession.expiresAt).toISOString() : 'null'}\n`);
      const _dbgSecure = _isSecureRequest(req); process.stdout.write(`  cookie    : ${COOKIE_NAME}=… secure=${_dbgSecure} sameSite=${_dbgSecure ? 'none' : 'lax'}\n`);
      process.stdout.write("\x1b[42m\x1b[30m──────────────────────────────────\x1b[0m\n\n");
      // ─────────────────────────────────────────────────────────────────

      return res.json({ id: user._id, name: user.name, email: user.email, role: user.role, sessionId });
    } catch (err) { return handleError(res, 'POST /api/auth/login', err); }
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    try {
      const { sessionId } = readSessionFromReq(req);
      if (sessionId) sessionDestroy(sessionId);
      clearSessionCookie(res, req);
      return res.json({ message: "Logout feito" });
    } catch (err) { return handleError(res, 'POST /api/auth/logout', err); }
  }

  if (pathname.startsWith("/api/auth/me") && method === "GET") {
    try {
      // Tenta sessão nova primeiro
      const { sessionId, data: sessData } = readSessionFromReq(req);
      if (sessionId && sessData) {
        const _id  = toObjectId(sessData.userId);
        if (_id) {
          const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
          if (user) {
            sessionRenew(sessionId);
            return res.json({ id: user._id, name: user.name, email: user.email, role: user.role, active: user.active });
          }
        }
      }
      // Fallback JWT legado
      const t = readTokenFromReq(req);
      if (t?.uid) {
        const _id = toObjectId(t.uid);
        if (_id) {
          const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
          if (user) return res.json({ id: user._id, name: user.name, email: user.email, role: user.role, active: user.active });
        }
      }
      return res.status(401).json({ error: "Sem sessão" });
    } catch (err) { return handleError(res, 'GET /api/auth/me', err); }
  }

  // ── Endpoint de diagnóstico de sessões (apenas master) ───────────────────
  if (pathname === "/api/auth/sessions" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem ver sessões" });
      const rows = sessionsRead();
      const now  = Date.now();
      const list = rows.map((s) => ({
        sessionId:  s.id.substring(0, 8) + "…",
        userId:     s.user_id,
        name:       s.name,
        email:      s.email,
        role:       s.role,
        createdAt:  new Date(s.created_at).toISOString(),
        expiresAt:  new Date(s.expires_at).toISOString(),
        expiresIn:  Math.max(0, Math.round((s.expires_at - now) / 1000 / 60)) + " min",
      }));
      return res.json({ status: "ok", total: list.length, sessions: list });
    } catch (err) { return handleError(res, 'GET /api/auth/sessions', err); }
  }

  // ============================================================================
  // PIPELINE CONFIG
  // ============================================================================
  if (pathname === "/api/pipeline/config" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      let config = await pipelineConfigCollection.findOne({ userId: String(authUser._id) });
      if (!config && !canSeeAll(authUser)) config = await pipelineConfigCollection.findOne({ scope: "global" });
      if (!config) return res.json({ status: "ok", config: null });
      return res.json({ status: "ok", config: config.data });
    } catch (err) { return handleError(res, 'GET /api/pipeline/config', err); }
  }

  if (pathname === "/api/pipeline/config" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { config, scope } = body || {};
      if (!config || !Array.isArray(config.columns)) return res.status(400).json({ error: "config.columns é obrigatório" });
      for (const col of config.columns) { if (!col.id || !col.label) return res.status(400).json({ error: "Cada coluna precisa de id e label" }); }
      const now = new Date();
      if (scope === "global" && canSeeAll(authUser)) {
        await pipelineConfigCollection.updateOne({ scope: "global" }, { $set: { scope: "global", data: config, updatedBy: String(authUser._id), updatedAt: now } }, { upsert: true });
        return res.json({ status: "ok", message: "Config global guardada" });
      }
      await pipelineConfigCollection.updateOne({ userId: String(authUser._id) }, { $set: { userId: String(authUser._id), data: config, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
      return res.json({ status: "ok", message: "Config do pipeline guardada" });
    } catch (err) { return handleError(res, 'POST /api/pipeline/config', err); }
  }

  if (pathname === "/api/pipeline/config" && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      await pipelineConfigCollection.deleteOne({ userId: String(authUser._id) });
      return res.json({ status: "ok", message: "Config reposta para padrão" });
    } catch (err) { return handleError(res, 'DELETE /api/pipeline/config', err); }
  }

  if (pathname === "/api/pipeline/config/global" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!canSeeAll(authUser)) return res.status(403).json({ error: "Apenas admins podem ver a config global" });
      const config = await pipelineConfigCollection.findOne({ scope: "global" });
      return res.json({ status: "ok", config: config?.data || null });
    } catch (err) { return handleError(res, 'GET /api/pipeline/config/global', err); }
  }

  if (pathname === '/api/pipeline/order' && method === 'GET') {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const doc = await pipelineOrderCollection.findOne({ userId: String(authUser._id) });
      return res.json({ status: 'ok', order: doc?.order || {} });
    } catch (err) { return handleError(res, 'GET /api/pipeline/order', err); }
  }

  if (pathname === '/api/pipeline/order' && method === 'POST') {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { order } = body || {};
      if (!order || typeof order !== 'object') return res.status(400).json({ error: 'order é obrigatório' });
      for (const [col, ids] of Object.entries(order)) { if (!Array.isArray(ids)) return res.status(400).json({ error: `order.${col} deve ser um array` }); }
      await pipelineOrderCollection.updateOne({ userId: String(authUser._id) }, { $set: { userId: String(authUser._id), order, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
      return res.json({ status: 'ok', message: 'Ordem guardada' });
    } catch (err) { return handleError(res, 'POST /api/pipeline/order', err); }
  }

  if (pathname === '/api/pipeline/attachment' && method === 'DELETE') {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { itemId, itemType, attachmentIndex } = body || {};
      if (!itemId || !itemType || attachmentIndex === undefined) return res.status(400).json({ error: 'itemId, itemType e attachmentIndex são obrigatórios' });
      const _idObj = toObjectId(itemId);
      if (!_idObj) return res.status(400).json({ error: 'itemId inválido' });
      const typeMap = { lead: { col: leadsCollection }, contacto: { col: contactosCollection }, reuniao: { col: reunioesCollection }, proposta: { col: proposalsCollection } };
      const m = typeMap[itemType];
      if (!m) return res.status(400).json({ error: 'itemType inválido' });
      const doc = await m.col.findOne({ _id: _idObj });
      if (!doc) return res.status(404).json({ error: 'Registo não encontrado' });
      if (!canSeeAll(authUser) && doc.createdBy !== String(authUser._id)) return res.status(403).json({ error: 'Acesso negado' });
      const attachments = doc.pipelineAttachments || [];
      const idx = Number(attachmentIndex);
      if (isNaN(idx) || idx < 0 || idx >= attachments.length) return res.status(400).json({ error: 'attachmentIndex inválido' });
      const att = attachments[idx];
      if (att?.url && att.url.startsWith('/uploads/')) {
        try { const fp = path.join(__dirname, att.url); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e) { console.error("[WARN] Falha ao apagar ficheiro local:", e); }
      }
      attachments.splice(idx, 1);
      await m.col.updateOne({ _id: _idObj }, { $set: { pipelineAttachments: attachments, updatedAt: new Date() } });
      return res.json({ status: 'ok', message: 'Anexo removido' });
    } catch (err) { return handleError(res, 'DELETE /api/pipeline/attachment', err); }
  }

  // ============================================================================
  // USERS
  // ============================================================================
  if (pathname === "/api/users" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem gerir contas" });
      const roleFilter = query?.role || null;
      const filter = {};
      if (roleFilter) filter.role = roleFilter;
      const users = await usersCollection.find(filter, { projection: { password: 0 } }).sort({ createdAt: -1 }).toArray();
      return res.json({ status: "ok", total: users.length, users });
    } catch (err) { return handleError(res, 'GET /api/users', err); }
  }

  if (pathname === "/api/users" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem criar contas" });
      const { name, email, password, role, active } = body || {};
      if (!name || !email || !password) return res.status(400).json({ error: "name, email e password são obrigatórios" });
      if (password.length < 8) return res.status(400).json({ error: "Password mínimo 8 caracteres" });
      const validRoles = ["master","comercial-master","comercial"];
      if (role && !validRoles.includes(role)) return res.status(400).json({ error: "Role inválido" });
      const exists = await usersCollection.findOne({ email: email.toLowerCase().trim() });
      if (exists) return res.status(409).json({ error: "Email já registado" });
      const hash = await bcrypt.hash(password, 10);
      const now  = new Date();
      const doc  = { name: name.trim(), email: email.toLowerCase().trim(), password: hash, role: validRoles.includes(role) ? role : "comercial", active: active !== false, createdBy: String(authUser._id), createdAt: now, updatedAt: now };
      const result = await usersCollection.insertOne(doc);
      const { password: _, ...safe } = doc;
      return res.status(201).json({ status: "ok", user: { ...safe, id: result.insertedId, _id: result.insertedId } });
    } catch (err) { return handleError(res, 'POST /api/users', err); }
  }

  if (userIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(userIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const isSelf = String(authUser._id) === String(_id);
      if (!isMaster(authUser) && !isSelf) return res.status(403).json({ error: "Acesso negado" });
      const user = await usersCollection.findOne({ _id }, { projection: { password: 0 } });
      if (!user) return res.status(404).json({ error: "Utilizador não encontrado" });
      return res.json({ status: "ok", user: { ...user, id: user._id } });
    } catch (err) { return handleError(res, 'GET /api/users/:id', err); }
  }

  if (userIdMatch && method === "PUT") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem editar contas" });
      const _id = toObjectId(userIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const { name, email, role, active, password } = body || {};
      const validRoles = ["master","comercial-master","comercial"];
      const updateData = { updatedAt: new Date() };
      if (name)  updateData.name   = name.trim();
      if (email) updateData.email  = email.toLowerCase().trim();
      if (role && validRoles.includes(role)) updateData.role = role;
      if (typeof active === "boolean") updateData.active = active;
      if (password) { if (password.length < 8) return res.status(400).json({ error: "Password mínimo 8 caracteres" }); updateData.password = await bcrypt.hash(password, 10); }
      const result  = await usersCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Utilizador não encontrado" });
      const { password: _, ...safe } = updated;
      return res.json({ status: "ok", user: { ...safe, id: updated._id } });
    } catch (err) { return handleError(res, 'PUT /api/users/:id', err); }
  }

  if (userStatusMatch && method === "PATCH") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem alterar estados" });
      const _id = toObjectId(userStatusMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const { active } = body || {};
      if (typeof active !== "boolean") return res.status(400).json({ error: "active deve ser boolean" });
      const result  = await usersCollection.findOneAndUpdate({ _id }, { $set: { active, updatedAt: new Date() } }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Utilizador não encontrado" });
      const { password: _, ...safe } = updated;
      return res.json({ status: "ok", user: { ...safe, id: updated._id } });
    } catch (err) { return handleError(res, 'PATCH /api/users/:id/status', err); }
  }

  if (userPasswordMatch && method === "PATCH") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id    = toObjectId(userPasswordMatch[1]);
      if (!_id)    return res.status(400).json({ error: "ID inválido" });
      const isSelf = String(authUser._id) === String(_id);
      if (!isMaster(authUser) && !isSelf) return res.status(403).json({ error: "Acesso negado" });
      const { password, currentPassword } = body || {};
      if (!password || password.length < 8) return res.status(400).json({ error: "Password mínimo 8 caracteres" });
      if (isSelf && !isMaster(authUser)) {
        if (!currentPassword) return res.status(400).json({ error: "Forneça a password atual" });
        const userDoc = await usersCollection.findOne({ _id });
        const ok = userDoc && await bcrypt.compare(currentPassword, userDoc.password);
        if (!ok) return res.status(401).json({ error: "Password atual incorreta" });
      }
      const hash = await bcrypt.hash(password, 10);
      await usersCollection.updateOne({ _id }, { $set: { password: hash, updatedAt: new Date() } });
      return res.json({ status: "ok", message: "Password alterada com sucesso" });
    } catch (err) { return handleError(res, 'PATCH /api/users/:id/password', err); }
  }

  if (userIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem eliminar contas" });
      const _id = toObjectId(userIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      if (String(authUser._id) === String(_id)) return res.status(400).json({ error: "Não pode eliminar a sua própria conta" });
      const del = await usersCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Utilizador não encontrado" });
      return res.json({ status: "ok", message: "Conta eliminada com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/users/:id', err); }
  }

  // ============================================================================
  // BLOGS
  // ============================================================================
  if (pathname === "/api/blogs" && method === "GET") {
    try {
      const category = query?.category;
      const q        = query?.q;
      const page     = parseInt(query?.page  || "1",  10);
      const limit    = parseInt(query?.limit || "10", 10);
      const filter = {};
      if (category) filter.blog_category = category;
      if (q) { filter.$or = [{ blog_title:{ $regex:q,$options:"i" }},{ blog_short_description:{$regex:q,$options:"i"}},{ blog_description:{$regex:q,$options:"i"}}]; }
      const skip  = (page - 1) * limit;
      const items = await blogsCollection.find(filter).sort({ blog_postdate: -1 }).skip(skip).limit(limit).toArray();
      const total = await blogsCollection.countDocuments(filter);
      const articles = items.map((blog) => ({ source:{id:null,name:"MyBlogAPI"}, author:blog.author?.toString()||"Unknown", title:blog.blog_title, description:blog.blog_description, short_description:blog.blog_short_description, urlToImage:blog.blog_image_url||"", components:blog.blog_components, postdate:blog.blog_postdate, tags:(blog.blog_description+" "+blog.blog_title).split(" "), publishedAt:toIso(blog.blog_postdate)||toIso(blog.createdAt)||toIso(new Date()), content:blog.blog_description, category:blog.blog_category, id:blog._id }));
      return res.json({ status: "ok", totalResults: total, articles });
    } catch (err) { return handleError(res, 'GET /api/blogs', err); }
  }

  if (pathname === "/api/blogs" && method === "POST") {
    try {
      console.log("data kiosso = ");
      const { blog_title, blog_description, blog_short_description, blog_category, blog_image_url, blog_postdate, blog_status, blog_components } = body || {};
      if (!blog_title || !blog_description || !blog_short_description || !blog_category) return res.status(400).json({ error: "Campos obrigatórios faltando" });
      const now = new Date();
      const doc = { blog_title, blog_description, blog_short_description, blog_category, blog_image_url: blog_image_url||"", blog_postdate: blog_postdate ? new Date(blog_postdate) : now, blog_status: blog_status||"published", blog_components: blog_components||[], createdAt: now, updatedAt: now };
      const result = await blogsCollection.insertOne(doc);
      const saved  = { _id: result.insertedId, ...doc };
      return res.status(201).json({ status:"ok", article:{ source:{id:null,name:"MyBlogAPI"}, author:"Unknown", title:saved.blog_title, description:saved.blog_description, short_description:saved.blog_short_description, urlToImage:saved.blog_image_url||"", publishedAt:toIso(saved.blog_postdate)||toIso(saved.createdAt), content:saved.blog_description, category:saved.blog_category, status:saved.blog_status, components:saved.blog_components, id:saved._id } });
    } catch (err) { return handleError(res, 'POST /api/blogs', err); }
  }

  if (blogIdMatch) {
    try {
      const _id = toObjectId(blogIdMatch[1]);
      if (!_id) return res.status(400).json({ status: "error", error: "ID inválido" });
      if (method === "GET") {
        const post = await blogsCollection.findOne({ _id });
        if (!post) return res.status(404).json({ status: "error", error: "Post não encontrado" });
        return res.json({ status:"ok", article:{ source:{id:null,name:"MyBlogAPI"}, author:post.author?.toString()||"Unknown", title:post.blog_title, description:post.blog_description, short_description:post.blog_short_description, urlToImage:post.blog_image_url||"", publishedAt:toIso(post.blog_postdate)||toIso(post.createdAt), content:post.blog_description, category:post.blog_category, status:post.blog_status||"published", components:post.blog_components||[], id:post._id } });
      }
      if (method === "PUT") {
        const updateData = { ...(body || {}), updatedAt: new Date() };
        if (updateData.blog_postdate) updateData.blog_postdate = new Date(updateData.blog_postdate);
        const result  = await blogsCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
        const post    = result?.value ?? result;
        if (!post) return res.status(404).json({ status: "error", error: "Post não encontrado" });
        return res.json({ status:"ok", article:{ source:{id:null,name:"MyBlogAPI"}, author:post.author?.toString()||"Unknown", title:post.blog_title, description:post.blog_description, short_description:post.blog_short_description, urlToImage:post.blog_image_url||"", publishedAt:toIso(post.blog_postdate)||toIso(post.createdAt), content:post.blog_description, category:post.blog_category, status:post.blog_status||"published", components:post.blog_components||[], id:post._id } });
      }
      if (method === "DELETE") {
        const del = await blogsCollection.deleteOne({ _id });
        if (!del.deletedCount) return res.status(404).json({ status: "error", error: "Post não encontrado" });
        return res.json({ status: "ok", message: "Post removido com sucesso" });
      }
    } catch (err) { return handleError(res, `${method} /api/blogs/:id`, err); }
  }

  // ============================================================================
  // NEWSLETTER
  // ============================================================================
  if (pathname === "/api/newsletter" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem ver a newsletter" });
      const subscribers = await newsletterCollection.find({}).sort({ subscribedAt: -1 }).toArray();
      return res.json({ status: "ok", total: subscribers.length, subscribers });
    } catch (err) { return handleError(res, 'GET /api/newsletter', err); }
  }

  if (pathname === "/api/newsletter" && method === "POST") {
    try {
      const { name, company, email, position } = body || {};
      if (!name || !company || !email || !position) return res.status(400).json({ error: "Campos obrigatórios: name, company, email, position" });
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return res.status(400).json({ error: "Email inválido" });
      const exists = await newsletterCollection.findOne({ email: email.toLowerCase() });
      if (exists) return res.status(409).json({ error: "Este email já se encontra subscrito" });
      const doc = { name: name.trim(), company: company.trim(), email: email.toLowerCase().trim(), position, subscribedAt: new Date() };
      const result = await newsletterCollection.insertOne(doc);
      return res.status(201).json({ status: "ok", message: "Subscrição realizada com sucesso!", subscriber: { id: result.insertedId, ...doc } });
    } catch (err) { return handleError(res, 'POST /api/newsletter', err); }
  }

  if (newsletterIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem remover subscritores" });
      const _id = toObjectId(newsletterIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const del = await newsletterCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Subscritor não encontrado" });
      return res.json({ status: "ok", message: "Subscritor removido com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/newsletter/:id', err); }
  }

  // ============================================================================
  // PROPOSALS
  // ============================================================================
  if (pathname === "/api/proposals" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const statusFilter = query?.status || null;
      const clientFilter = query?.client || null;
      const page  = parseInt(query?.page  || "1",  10);
      const limit = parseInt(query?.limit || "50", 10);
      const filter = {};
      if (!canSeeAll(authUser)) Object.assign(filter, comercialFilter(authUser));
      if (statusFilter) filter.status     = statusFilter;
      if (clientFilter) filter.clientName = { $regex: clientFilter, $options: "i" };
      const skip = (page - 1) * limit;
      const pipeline_agg = [
        { $match: filter },
        { $sort: { sentAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $lookup: { from: "contactos", let: { cid: { $cond: { if: { $and: ["$contactoId", { $ne: ["$contactoId", null] }] }, then: { $toObjectId: "$contactoId" }, else: null } } }, pipeline: [ { $match: { $expr: { $and: [{ $ne: ["$$cid", null] }, { $eq: ["$_id", "$$cid"] }] } } }, { $project: { empresa: 1, email: 1, telefone: 1 } } ], as: "_contactoData" } },
        { $addFields: { clientName: { $cond: { if: { $gt: [{ $size: "$_contactoData" }, 0] }, then: { $arrayElemAt: ["$_contactoData.empresa", 0] }, else: "$clientName" } } } },
        { $project: { _contactoData: 0 } }
      ];
      const items = await proposalsCollection.aggregate(pipeline_agg).toArray();
      const total = await proposalsCollection.countDocuments(filter);
      return res.json({ status: "ok", total, proposals: items.map(p => ({ ...p, id: p._id })) });
    } catch (err) { return handleError(res, 'GET /api/proposals', err); }
  }

  if (pathname === "/api/proposals" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { projectName, refCode, clientName, contactoId, validity, salesName, salesRole, salesEmail, notes, sections, lines, grandTotal, annualTotal, monthlyTotal, oneoffTotal, status } = body || {};
      if (!clientName) return res.status(400).json({ error: "clientName é obrigatório" });
      const now = new Date();
      const doc = { projectName: projectName||"", refCode: refCode||"", clientName: clientName||"", contactoId: contactoId ? String(contactoId) : null, validity: validity||"", salesName: salesName||"", salesRole: salesRole||"", salesEmail: salesEmail||"", notes: notes||"", sections: sections||{}, lines: lines||{}, grandTotal: Number(grandTotal)||0, annualTotal: Number(annualTotal)||0, monthlyTotal: Number(monthlyTotal)||0, oneoffTotal: Number(oneoffTotal)||0, status: status||"enviada", createdBy: String(authUser._id), sentAt: now, createdAt: now, updatedAt: now };
      const result = await proposalsCollection.insertOne(doc);
      return res.status(201).json({ status: "ok", proposal: { ...doc, id: result.insertedId, _id: result.insertedId } });
    } catch (err) { return handleError(res, 'POST /api/proposals', err); }
  }

  if (proposalIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(proposalIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const proposal = await proposalsCollection.findOne({ _id });
      if (!proposal) return res.status(404).json({ error: "Proposta não encontrada" });
      if (!canSeeAll(authUser) && proposal.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      let clientName = proposal.clientName;
      if (proposal.contactoId) {
        const cOid = toObjectId(proposal.contactoId);
        if (cOid) {
          const contacto = await contactosCollection.findOne({ _id: cOid }, { projection: { empresa: 1 } });
          if (contacto?.empresa) clientName = contacto.empresa;
        }
      }
      return res.json({ status: "ok", proposal: { ...proposal, clientName, id: proposal._id } });
    } catch (err) { return handleError(res, 'GET /api/proposals/:id', err); }
  }

  if (proposalIdMatch && method === "PUT") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(proposalIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const proposal = await proposalsCollection.findOne({ _id });
      if (!proposal) return res.status(404).json({ error: "Proposta não encontrada" });
      if (isComercial(authUser) && proposal.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const updateData = { ...(body || {}), grandTotal: Number(body?.grandTotal)||0, annualTotal: Number(body?.annualTotal)||0, monthlyTotal: Number(body?.monthlyTotal)||0, oneoffTotal: Number(body?.oneoffTotal)||0, updatedAt: new Date() };
      if (body?.contactoId !== undefined) updateData.contactoId = body.contactoId ? String(body.contactoId) : null;
      delete updateData._id; delete updateData.id; delete updateData.createdBy;
      const result  = await proposalsCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Proposta não encontrada" });
      return res.json({ status: "ok", proposal: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PUT /api/proposals/:id', err); }
  }

  if (proposalStatusMatch && method === "PATCH") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(proposalStatusMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const { status } = body || {};
      const validStatuses = ["rascunho","enviada","em_analise","adjudicada","perdida","cancelada"];
      if (!status || !validStatuses.includes(status)) return res.status(400).json({ error: "Status inválido" });
      const proposal = await proposalsCollection.findOne({ _id });
      if (!proposal) return res.status(404).json({ error: "Proposta não encontrada" });
      if (isComercial(authUser) && proposal.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const result  = await proposalsCollection.findOneAndUpdate({ _id }, { $set: { status, updatedAt: new Date() } }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      return res.json({ status: "ok", proposal: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PATCH /api/proposals/:id/status', err); }
  }

  if (proposalIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(proposalIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const proposal = await proposalsCollection.findOne({ _id });
      if (!proposal) return res.status(404).json({ error: "Proposta não encontrada" });
      if (!isMaster(authUser) && proposal.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const del = await proposalsCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Proposta não encontrada" });
      return res.json({ status: "ok", message: "Proposta removida com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/proposals/:id', err); }
  }

  // ============================================================================
  // LEADS
  // ============================================================================
  if (pathname === "/api/leads" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const filter = {};
      if (!canSeeAll(authUser)) Object.assign(filter, comercialFilter(authUser));
      if (query?.estado)  filter.estado  = query.estado;
      if (query?.origem)  filter.origem  = query.origem;
      if (query?.empresa) filter.empresa = { $regex: query.empresa, $options: "i" };
      const page  = parseInt(query?.page  || "1",   10);
      const limit = parseInt(query?.limit || "200", 10);
      const skip  = (page - 1) * limit;
      const items = await leadsCollection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      const total = await leadsCollection.countDocuments(filter);
      return res.json({ status: "ok", total, leads: items.map(l => ({ ...l, id: l._id })) });
    } catch (err) { return handleError(res, 'GET /api/leads', err); }
  }

  if (pathname === "/api/leads" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { empresa, data, contacto, telefone, email, origem, estado, obs, contactoId } = body || {};
      if (!empresa) return res.status(400).json({ error: "empresa é obrigatório" });
      const validEstados = ["Novo","Contactado","Qualificado","Perdido"];
      const validOrigens = ["Website","Referral","Evento","Telefone","LinkedIn","Outro"];
      const now = new Date();
      const doc = { empresa: empresa.trim(), data: data||now.toISOString().split("T")[0], contacto: contacto||"", telefone: telefone||"", email: (email||"").toLowerCase().trim(), origem: validOrigens.includes(origem)?origem:"Outro", estado: validEstados.includes(estado)?estado:"Novo", obs: obs||"", contactoId: contactoId?String(contactoId):null, createdBy: String(authUser._id), createdAt: now, updatedAt: now };
      const result = await leadsCollection.insertOne(doc);
      return res.status(201).json({ status: "ok", lead: { ...doc, id: result.insertedId, _id: result.insertedId } });
    } catch (err) { return handleError(res, 'POST /api/leads', err); }
  }

  if (leadIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(leadIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const lead = await leadsCollection.findOne({ _id });
      if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
      if (!canSeeAll(authUser) && lead.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      return res.json({ status: "ok", lead: { ...lead, id: lead._id } });
    } catch (err) { return handleError(res, 'GET /api/leads/:id', err); }
  }

  if (leadIdMatch && method === "PUT") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(leadIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const lead = await leadsCollection.findOne({ _id });
      if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
      if (isComercial(authUser) && lead.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const { empresa, data, contacto, telefone, email, origem, estado, obs, contactoId } = body || {};
      if (!empresa) return res.status(400).json({ error: "empresa é obrigatório" });
      const validEstados = ["Novo","Contactado","Qualificado","Perdido"];
      const validOrigens = ["Website","Referral","Evento","Telefone","LinkedIn","Outro"];
      const updateData = { empresa: empresa.trim(), data: data||"", contacto: contacto||"", telefone: telefone||"", email: (email||"").toLowerCase().trim(), origem: validOrigens.includes(origem)?origem:"Outro", estado: validEstados.includes(estado)?estado:"Novo", obs: obs||"", contactoId: contactoId!==undefined?(contactoId?String(contactoId):null):(lead.contactoId||null), pipelineColOverride: body?.pipelineColOverride!==undefined?(body.pipelineColOverride||null):(lead.pipelineColOverride||null), updatedAt: new Date() };
      const result  = await leadsCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Lead não encontrado" });
      return res.json({ status: "ok", lead: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PUT /api/leads/:id', err); }
  }

  if (leadStatusMatch && method === "PATCH") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(leadStatusMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const { estado } = body || {};
      const validEstados = ["Novo","Contactado","Qualificado","Perdido"];
      if (!estado || !validEstados.includes(estado)) return res.status(400).json({ error: "Estado inválido" });
      const lead = await leadsCollection.findOne({ _id });
      if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
      if (isComercial(authUser) && lead.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const result  = await leadsCollection.findOneAndUpdate({ _id }, { $set: { estado, updatedAt: new Date() } }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      return res.json({ status: "ok", lead: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PATCH /api/leads/:id/status', err); }
  }

  if (leadIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(leadIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const lead = await leadsCollection.findOne({ _id });
      if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
      if (!isMaster(authUser) && lead.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const del = await leadsCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Lead não encontrado" });
      return res.json({ status: "ok", message: "Lead removido com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/leads/:id', err); }
  }

  // ============================================================================
  // CONTACTOS
  // ============================================================================
  if (pathname === "/api/contactos" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const filter = {};
      if (!canSeeAll(authUser)) Object.assign(filter, comercialFilter(authUser));
      if (query?.estado)  filter.estado  = query.estado;
      if (query?.empresa) filter.empresa = { $regex: query.empresa, $options: "i" };
      const page  = parseInt(query?.page  || "1",   10);
      const limit = parseInt(query?.limit || "200", 10);
      const skip  = (page - 1) * limit;
      const items = await contactosCollection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      const total = await contactosCollection.countDocuments(filter);
      return res.json({ status: "ok", total, contactos: items.map(c => ({ ...c, id: c._id })) });
    } catch (err) { return handleError(res, 'GET /api/contactos', err); }
  }

  if (pathname === "/api/contactos" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { empresa, data, tentativas, telefone, email, obs, notas } = body || {};
      if (!empresa) return res.status(400).json({ error: "empresa é obrigatório" });
      const now = new Date();
      const doc = { empresa: empresa.trim(), data: data||now.toISOString().split("T")[0], tentativas: Number(tentativas)||1, telefone: telefone||"", email: (email||"").toLowerCase().trim(), obs: obs||"", notas: Array.isArray(notas)?notas:[], createdBy: String(authUser._id), createdAt: now, updatedAt: now };
      const result = await contactosCollection.insertOne(doc);
      return res.status(201).json({ status: "ok", contacto: { ...doc, id: result.insertedId, _id: result.insertedId } });
    } catch (err) { return handleError(res, 'POST /api/contactos', err); }
  }

  if (contactoIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(contactoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const contacto = await contactosCollection.findOne({ _id });
      if (!contacto) return res.status(404).json({ error: "Contacto não encontrado" });
      if (!canSeeAll(authUser) && contacto.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      return res.json({ status: "ok", contacto: { ...contacto, id: contacto._id } });
    } catch (err) { return handleError(res, 'GET /api/contactos/:id', err); }
  }

  if (contactoIdMatch && method === "PUT") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(contactoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const contacto = await contactosCollection.findOne({ _id });
      if (!contacto) return res.status(404).json({ error: "Contacto não encontrado" });
      if (isComercial(authUser) && contacto.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const { empresa, data, tentativas, telefone, email, obs, notas } = body || {};
      if (!empresa) return res.status(400).json({ error: "empresa é obrigatório" });
      const updateData = { empresa: empresa.trim(), data: data||"", tentativas: Number(tentativas)||1, telefone: telefone||"", email: (email||"").toLowerCase().trim(), obs: obs||"", notas: Array.isArray(notas)?notas:[], pipelineColOverride: body?.pipelineColOverride!==undefined?(body.pipelineColOverride||null):(contacto.pipelineColOverride||null), updatedAt: new Date() };
      const result  = await contactosCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Contacto não encontrado" });
      return res.json({ status: "ok", contacto: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PUT /api/contactos/:id', err); }
  }

  if (contactoNotasMatch && method === "PATCH") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(contactoNotasMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const contacto = await contactosCollection.findOne({ _id });
      if (!contacto) return res.status(404).json({ error: "Contacto não encontrado" });
      if (isComercial(authUser) && contacto.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const { notas } = body || {};
      if (!Array.isArray(notas)) return res.status(400).json({ error: "notas deve ser um array" });
      const result  = await contactosCollection.findOneAndUpdate({ _id }, { $set: { notas, updatedAt: new Date() } }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      return res.json({ status: "ok", contacto: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PATCH /api/contactos/:id/notas', err); }
  }

  if (contactoIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(contactoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const contacto = await contactosCollection.findOne({ _id });
      if (!contacto) return res.status(404).json({ error: "Contacto não encontrado" });
      if (!isMaster(authUser) && contacto.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const del = await contactosCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Contacto não encontrado" });
      return res.json({ status: "ok", message: "Contacto removido com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/contactos/:id', err); }
  }

  // ============================================================================
  // REUNIÕES
  // ============================================================================
  if (pathname === "/api/reunioes" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const filter = {};
      if (!canSeeAll(authUser)) Object.assign(filter, comercialFilter(authUser));
      if (query?.estado)  filter.estado  = query.estado;
      if (query?.empresa) filter.empresa = { $regex: query.empresa, $options: "i" };
      const page  = parseInt(query?.page  || "1",   10);
      const limit = parseInt(query?.limit || "200", 10);
      const skip  = (page - 1) * limit;
      const pipeline_agg = [
        { $match: filter },
        { $sort: { data: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $lookup: { from: "contactos", let: { cid: { $cond: { if: { $and: ["$contactoId", { $ne: ["$contactoId", null] }] }, then: { $toObjectId: "$contactoId" }, else: null } } }, pipeline: [ { $match: { $expr: { $and: [{ $ne: ["$$cid", null] }, { $eq: ["$_id", "$$cid"] }] } } }, { $project: { empresa: 1, email: 1, telefone: 1 } } ], as: "_contactoData" } },
        { $addFields: { empresa: { $cond: { if: { $gt: [{ $size: "$_contactoData" }, 0] }, then: { $arrayElemAt: ["$_contactoData.empresa", 0] }, else: "$empresa" } } } },
        { $project: { _contactoData: 0 } }
      ];
      const items = await reunioesCollection.aggregate(pipeline_agg).toArray();
      const total = await reunioesCollection.countDocuments(filter);
      return res.json({ status: "ok", total, reunioes: items.map(r => ({ ...r, id: r._id })) });
    } catch (err) { return handleError(res, 'GET /api/reunioes', err); }
  }

  if (pathname === "/api/reunioes" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { empresa, data, formato, local, estado, obs, contactoId } = body || {};
      if (!empresa) return res.status(400).json({ error: "empresa é obrigatório" });
      if (!data)    return res.status(400).json({ error: "data é obrigatória" });
      const validEstados  = ["Agendada","Realizada","Não Realizada"];
      const validFormatos = ["Online","Presencial","Chamada"];
      const now = new Date();
      const doc = { empresa: empresa.trim(), data, formato: validFormatos.includes(formato)?formato:"Online", local: local||"", estado: validEstados.includes(estado)?estado:"Agendada", obs: obs||"", contactoId: contactoId?String(contactoId):null, createdBy: String(authUser._id), createdAt: now, updatedAt: now };
      const result = await reunioesCollection.insertOne(doc);
      return res.status(201).json({ status: "ok", reuniao: { ...doc, id: result.insertedId, _id: result.insertedId } });
    } catch (err) { return handleError(res, 'POST /api/reunioes', err); }
  }

  if (reuniaoIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(reuniaoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const reuniao = await reunioesCollection.findOne({ _id });
      if (!reuniao) return res.status(404).json({ error: "Reunião não encontrada" });
      if (!canSeeAll(authUser) && reuniao.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      return res.json({ status: "ok", reuniao: { ...reuniao, id: reuniao._id } });
    } catch (err) { return handleError(res, 'GET /api/reunioes/:id', err); }
  }

  if (reuniaoIdMatch && method === "PUT") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(reuniaoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const reuniao = await reunioesCollection.findOne({ _id });
      if (!reuniao) return res.status(404).json({ error: "Reunião não encontrada" });
      if (isComercial(authUser) && reuniao.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const { empresa, data, formato, local, estado, obs, contactoId } = body || {};
      if (!empresa) return res.status(400).json({ error: "empresa é obrigatório" });
      const validEstados  = ["Agendada","Realizada","Não Realizada"];
      const validFormatos = ["Online","Presencial","Chamada"];
      const updateData = { empresa: empresa.trim(), data: data||"", formato: validFormatos.includes(formato)?formato:"Online", local: local||"", estado: validEstados.includes(estado)?estado:"Agendada", obs: obs||"", contactoId: contactoId!==undefined?(contactoId?String(contactoId):null):(reuniao.contactoId||null), pipelineColOverride: body?.pipelineColOverride!==undefined?(body.pipelineColOverride||null):(reuniao.pipelineColOverride||null), updatedAt: new Date() };
      const result  = await reunioesCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Reunião não encontrada" });
      return res.json({ status: "ok", reuniao: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PUT /api/reunioes/:id', err); }
  }

  if (reuniaoStatusMatch && method === "PATCH") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(reuniaoStatusMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const { estado } = body || {};
      const validEstados = ["Agendada","Realizada","Não Realizada"];
      if (!estado || !validEstados.includes(estado)) return res.status(400).json({ error: "Estado inválido" });
      const reuniao = await reunioesCollection.findOne({ _id });
      if (!reuniao) return res.status(404).json({ error: "Reunião não encontrada" });
      if (isComercial(authUser) && reuniao.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const result  = await reunioesCollection.findOneAndUpdate({ _id }, { $set: { estado, updatedAt: new Date() } }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      return res.json({ status: "ok", reuniao: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PATCH /api/reunioes/:id/status', err); }
  }

  if (reuniaoIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(reuniaoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const reuniao = await reunioesCollection.findOne({ _id });
      if (!reuniao) return res.status(404).json({ error: "Reunião não encontrada" });
      if (!isMaster(authUser) && reuniao.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const del = await reunioesCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Reunião não encontrada" });
      return res.json({ status: "ok", message: "Reunião removida com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/reunioes/:id', err); }
  }

  // ============================================================================
  // CUSTOS
  // ============================================================================
  if (pathname === "/api/custos" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const filter = {};
      if (!canSeeAll(authUser)) { Object.assign(filter, comercialFilter(authUser)); } else if (query?.userId) { filter.createdBy = query.userId; }
      if (query?.tipo) filter.tipo = query.tipo;
      if (query?.mes)  filter.mes  = query.mes;
      const page  = parseInt(query?.page  || "1",   10);
      const limit = parseInt(query?.limit || "200", 10);
      const skip  = (page - 1) * limit;
      const items = await custosCollection.find(filter).sort({ data: -1, createdAt: -1 }).skip(skip).limit(limit).toArray();
      const total = await custosCollection.countDocuments(filter);
      const aggResult = await custosCollection.aggregate([{ $match: filter }, { $group: { _id: null, totalValor: { $sum: "$valor" } } }]).toArray();
      const totalValor = aggResult[0]?.totalValor || 0;
      return res.json({ status: "ok", total, totalValor, custos: items.map(c => ({ ...c, id: c._id })) });
    } catch (err) { return handleError(res, 'GET /api/custos', err); }
  }

  if (pathname === "/api/custos" && method === "POST") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const { data, tipo, descricao, valor } = body || {};
      if (!descricao) return res.status(400).json({ error: "descricao é obrigatório" });
      if (!valor || isNaN(Number(valor))) return res.status(400).json({ error: "valor inválido" });
      const validTipos = ["Viagem","Alimentação","Alojamento","Telecomunicações","Material","Formação","Outro"];
      const now = new Date();
      const dataRegisto = data || now.toISOString().split("T")[0];
      const doc = { data: dataRegisto, mes: dataRegisto.substring(0, 7), tipo: validTipos.includes(tipo)?tipo:"Outro", descricao: descricao.trim(), valor: Number(Number(valor).toFixed(2)), createdBy: String(authUser._id), createdAt: now, updatedAt: now };
      const result = await custosCollection.insertOne(doc);
      return res.status(201).json({ status: "ok", custo: { ...doc, id: result.insertedId, _id: result.insertedId } });
    } catch (err) { return handleError(res, 'POST /api/custos', err); }
  }

  if (custoIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(custoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const custo = await custosCollection.findOne({ _id });
      if (!custo) return res.status(404).json({ error: "Custo não encontrado" });
      if (!canSeeAll(authUser) && custo.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      return res.json({ status: "ok", custo: { ...custo, id: custo._id } });
    } catch (err) { return handleError(res, 'GET /api/custos/:id', err); }
  }

  if (custoIdMatch && method === "PUT") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(custoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const custo = await custosCollection.findOne({ _id });
      if (!custo) return res.status(404).json({ error: "Custo não encontrado" });
      if (isComercial(authUser) && custo.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const { data, tipo, descricao, valor } = body || {};
      if (!descricao) return res.status(400).json({ error: "descricao é obrigatório" });
      if (!valor || isNaN(Number(valor))) return res.status(400).json({ error: "valor inválido" });
      const validTipos = ["Viagem","Alimentação","Alojamento","Telecomunicações","Material","Formação","Outro"];
      const dataRegisto = data || custo.data;
      const updateData = { data: dataRegisto, mes: dataRegisto.substring(0, 7), tipo: validTipos.includes(tipo)?tipo:"Outro", descricao: descricao.trim(), valor: Number(Number(valor).toFixed(2)), updatedAt: new Date() };
      const result  = await custosCollection.findOneAndUpdate({ _id }, { $set: updateData }, { returnDocument: "after" });
      const updated = result?.value ?? result;
      if (!updated) return res.status(404).json({ error: "Custo não encontrado" });
      return res.json({ status: "ok", custo: { ...updated, id: updated._id } });
    } catch (err) { return handleError(res, 'PUT /api/custos/:id', err); }
  }

  if (custoIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(custoIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const custo = await custosCollection.findOne({ _id });
      if (!custo) return res.status(404).json({ error: "Custo não encontrado" });
      if (!isMaster(authUser) && custo.createdBy !== String(authUser._id)) return res.status(403).json({ error: "Acesso negado" });
      const del = await custosCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Custo não encontrado" });
      return res.json({ status: "ok", message: "Custo removido com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/custos/:id', err); }
  }

  // ============================================================================
  // PÚBLICO — Pedido de contacto
  // ============================================================================
  if (pathname === "/api/public/contact" && method === "POST") {
    try {
      const {
        nif, name, company, sector, email, phone,
        employeesnumber, message, newsletter = false, source = "Website",
      } = body || {};

      if (!name || !company || !phone || !employeesnumber) {
        return res.status(400).json({
          success: false,
          error: "Os campos nome, empresa, telefone e número de colaboradores são obrigatórios.",
        });
      }

      const getSaudacao = () => {
        const h = new Date().getHours();
        if (h >= 6 && h < 12) return "Bom dia";
        if (h >= 12 && h < 20) return "Boa tarde";
        return "Boa noite";
      };
      const fmtDatePt = (d = new Date()) =>
        `${new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "long", year: "numeric" }).format(d)} às ${new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit" }).format(d)}`;

      const now      = new Date();
      const saudacao = getSaudacao();
      const dataStr  = fmtDatePt(now);

      const htmlInterno = `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="pt">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nova solicitação de orçamento — 2Smart HR</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background-color: #f2f2f2; font-family: Helvetica Neue, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body style="background-color:#f2f2f2;margin:0;padding:0;">

  <!-- TOP BAR -->
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td>
      <table align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#2261dd;margin:0 auto;width:675px;">
        <tr>
          <td style="padding:8px 20px;text-align:center;">
            <p style="margin:0;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:3px;line-height:1.5;">
              Software de gestão de assiduidades e recursos humanos
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>

  <!-- MAIN CARD -->
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td>
      <table align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#ffffff;margin:0 auto;width:675px;">
        <tr>
          <td style="padding:30px 40px 0;">

            <!-- LOGO -->
            <div style="text-align:center;margin-bottom:20px;">
              <img src="https://ik.imagekit.io/fsobpyaa5i/Ativo%208%20(2).png" alt="2Smart HR" style="height:36px;display:inline-block;">
            </div>

            <!-- SUBTITLE -->
            <p style="margin:0 0 6px;color:#2261dd;font-size:13px;font-weight:700;letter-spacing:3px;text-align:center;text-transform:uppercase;">
              Nova solicitação de orçamento
            </p>

            <!-- TITLE -->
            <h1 style="margin:0 0 6px;color:#152648;font-size:26px;font-weight:700;text-align:center;line-height:1.2;">
              ${saudacao}, <span style="color:#2261dd;">${name}</span> enviou um pedido
            </h1>
            <p style="margin:0 0 24px;color:#5a6c87;font-size:14px;text-align:center;line-height:1.6;">
              Recebido a ${dataStr}
            </p>

            <!-- KPI CARDS -->
            <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;">
              <tr>
                <td width="33%" style="padding:4px;">
                  <div style="background:#f4f7fc;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #e0e7f0;">
                    <div style="font-size:10px;font-weight:700;color:#7a8fa8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Empresa</div>
                    <div style="font-size:16px;font-weight:900;color:#152648;margin-bottom:2px;">${company}</div>
                    <div style="font-size:10px;color:#9ca3b8;">${sector || "—"}</div>
                  </div>
                </td>
                <td width="33%" style="padding:4px;">
                  <div style="background:linear-gradient(135deg,#2261dd,#0040cc);border-radius:10px;padding:14px 10px;text-align:center;">
                    <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,.8);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Colaboradores</div>
                    <div style="font-size:20px;font-weight:900;color:#ffffff;margin-bottom:2px;">${employeesnumber}</div>
                    <div style="font-size:10px;color:rgba(255,255,255,.7);">Dimensão da equipa</div>
                  </div>
                </td>
                <td width="33%" style="padding:4px;">
                  <div style="background:#f4f7fc;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #e0e7f0;">
                    <div style="font-size:10px;font-weight:700;color:#7a8fa8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Origem</div>
                    <div style="font-size:16px;font-weight:900;color:#2261dd;margin-bottom:2px;">${source}</div>
                    <div style="font-size:10px;color:#9ca3b8;">Canal</div>
                  </div>
                </td>
              </tr>
            </table>

            <!-- DADOS DO CLIENTE -->
            <div style="font-size:11px;font-weight:800;color:#2261dd;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e0e7f0;">
              Dados do cliente
            </div>
            <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;border-collapse:collapse;">
              <tr>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;width:40%;">Nome</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">${name}</td>
              </tr>
              <tr style="background:#f4f7fc;">
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Empresa</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">${company}</td>
              </tr>
              <tr>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">NIF</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">${nif || "—"}</td>
              </tr>
              <tr style="background:#f4f7fc;">
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Setor</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">${sector || "—"}</td>
              </tr>
              <tr>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Email</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#2261dd;">
                  <a href="mailto:${email || ""}" style="color:#2261dd;text-decoration:none;">${email || "—"}</a>
                </td>
              </tr>
              <tr style="background:#f4f7fc;">
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Telefone</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">
                  <a href="tel:${phone || ""}" style="color:#152648;text-decoration:none;">${phone || "—"}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Nº colaboradores</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">${employeesnumber}</td>
              </tr>
              <tr style="background:#f4f7fc;">
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;color:#374151;">Newsletter</td>
                <td style="padding:7px 10px;border-bottom:1px solid #e8eef7;font-size:12px;font-weight:700;color:#152648;">${newsletter ? "Sim" : "Não"}</td>
              </tr>
              <tr>
                <td style="padding:7px 10px;font-size:12px;color:#374151;vertical-align:top;">Mensagem</td>
                <td style="padding:7px 10px;font-size:12px;font-weight:500;color:#374151;line-height:1.6;">${message || "—"}</td>
              </tr>
            </table>

            <!-- CTA -->
            <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="padding:0 0 30px;text-align:center;">
                  <a href="https://crm.2smart.pt/" target="_blank"
                     style="background-color:#2261dd;color:#ffffff;display:inline-block;font-size:15px;font-weight:600;
                            text-decoration:none;padding:14px 36px;border-radius:6px;letter-spacing:.3px;">
                    ↪ Ver painel de leads
                  </a>
                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>
    </td></tr>
  </table>

  <!-- FOOTER -->
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td>
      <table align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#092a69;margin:0 auto;width:675px;">
        <tr>
          <td style="padding:30px 40px;">
            <div style="text-align:center;margin-bottom:14px;">
              <img src="https://media.beefree.cloud/pub/bfra/cu1zp9r2/fve/0lo/kgp/logo-2smart-17%20%281%29%20%282%29.png"
                   alt="2Smart HR" style="height:32px;display:inline-block;">
            </div>
            <p style="margin:0 0 16px;color:rgba(255,255,255,.8);font-size:13px;text-align:center;line-height:1.6;padding:0 20px;">
              A Plataforma Cloud com Portal de Colaborador integrada e dotada de IA que o ajuda a gerir eficientemente os seus RH.
            </p>
            <div style="text-align:center;margin-bottom:16px;">
              <a href="https://www.linkedin.com/company/2smart-hr/" target="_blank" style="display:inline-block;margin:0 4px;">
                <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/linkedin@2x.png" width="28" height="28" alt="LinkedIn" style="display:block;">
              </a>
              <a href="https://www.youtube.com/@2Smarthr" target="_blank" style="display:inline-block;margin:0 4px;">
                <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/youtube@2x.png" width="28" height="28" alt="YouTube" style="display:block;">
              </a>
              <a href="https://2smart.pt/" target="_blank" style="display:inline-block;margin:0 4px;">
                <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/website@2x.png" width="28" height="28" alt="Website" style="display:block;">
              </a>
            </div>
            <p style="margin:0;color:rgba(255,255,255,.4);font-size:10px;text-align:center;line-height:1.6;">
              © 2Smart HR · <a href="https://2smart.pt" style="color:rgba(255,255,255,.6);text-decoration:none;">www.2smart.pt</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>

</body>
</html>`;

      const htmlConfirmacao = `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Obrigado pelo contacto — 2Smart HR</title>
</head>
<body style="background-color:#f2f2f2;margin:0;padding:0;font-family:Helvetica Neue,Helvetica,Arial,sans-serif;">

  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td>
      <table align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#2261dd;margin:0 auto;width:675px;">
        <tr>
          <td style="padding:8px 20px;text-align:center;">
            <p style="margin:0;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:3px;">
              Software de gestão de assiduidades e recursos humanos
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>

  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td>
      <table align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#ffffff;margin:0 auto;width:675px;">
        <tr>
          <td style="padding:30px 40px;">
            <div style="text-align:center;margin-bottom:20px;">
              <img src="https://ik.imagekit.io/fsobpyaa5i/Ativo%208%20(2).png" alt="2Smart HR" style="height:36px;display:inline-block;">
            </div>
            <p style="margin:0 0 6px;color:#2261dd;font-size:13px;font-weight:700;letter-spacing:3px;text-align:center;text-transform:uppercase;">
              Obrigado pelo contacto
            </p>
            <h1 style="margin:0 0 16px;color:#152648;font-size:24px;font-weight:700;text-align:center;line-height:1.3;">
              ${saudacao}, <span style="color:#2261dd;">${name}</span>!
            </h1>
            <p style="margin:0 0 20px;color:#5a6c87;font-size:14px;text-align:center;line-height:1.7;">
              Recebemos a sua solicitação de orçamento referente à empresa <strong>${company}</strong>.<br>
              A nossa equipa irá analisar o seu pedido e entrar em contacto brevemente.
            </p>

            <div style="background:#f8fafd;border-radius:10px;padding:16px 18px;margin-bottom:24px;border:1px solid #e0e7f0;">
              <div style="font-size:11px;font-weight:800;color:#2261dd;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">
                Resumo do seu pedido
              </div>
              <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
                <tr>
                  <td style="font-size:12px;color:#5a6c87;padding:4px 0;width:45%;">Empresa</td>
                  <td style="font-size:12px;color:#152648;font-weight:700;padding:4px 0;">${company}</td>
                </tr>
                ${sector ? `<tr><td style="font-size:12px;color:#5a6c87;padding:4px 0;">Setor</td><td style="font-size:12px;color:#152648;font-weight:700;padding:4px 0;">${sector}</td></tr>` : ""}
                <tr>
                  <td style="font-size:12px;color:#5a6c87;padding:4px 0;">Nº de colaboradores</td>
                  <td style="font-size:12px;color:#152648;font-weight:700;padding:4px 0;">${employeesnumber}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:#5a6c87;padding:4px 0;">Telefone de contacto</td>
                  <td style="font-size:12px;color:#152648;font-weight:700;padding:4px 0;">${phone}</td>
                </tr>
                ${message ? `<tr><td style="font-size:12px;color:#5a6c87;padding:4px 0;vertical-align:top;">Mensagem</td><td style="font-size:12px;color:#152648;padding:4px 0;line-height:1.6;">${message}</td></tr>` : ""}
              </table>
            </div>

            <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="padding:0 0 30px;text-align:center;">
                  <a href="https://2smart.pt/request-information.html" target="_blank"
                     style="background-color:#2261dd;color:#ffffff;display:inline-block;font-size:15px;font-weight:600;
                            text-decoration:none;padding:14px 36px;border-radius:6px;letter-spacing:.3px;">
                    ↪ Agende uma demonstração gratuita
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>

  <!-- FOOTER -->
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td>
      <table align="center" width="675" border="0" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#092a69;margin:0 auto;width:675px;">
        <tr>
          <td style="padding:30px 40px;">
            <div style="text-align:center;margin-bottom:14px;">
              <img src="https://media.beefree.cloud/pub/bfra/cu1zp9r2/fve/0lo/kgp/logo-2smart-17%20%281%29%20%282%29.png"
                   alt="2Smart HR" style="height:32px;display:inline-block;">
            </div>
            <p style="margin:0 0 16px;color:rgba(255,255,255,.8);font-size:13px;text-align:center;line-height:1.6;padding:0 20px;">
              A Plataforma Cloud com Portal de Colaborador integrada e dotada de IA que o ajuda a gerir eficientemente os seus RH.
            </p>
            <div style="text-align:center;margin-bottom:16px;">
              <a href="https://www.linkedin.com/company/2smart-hr/" target="_blank" style="display:inline-block;margin:0 4px;">
                <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/linkedin@2x.png" width="28" height="28" alt="LinkedIn" style="display:block;">
              </a>
              <a href="https://www.youtube.com/@2Smarthr" target="_blank" style="display:inline-block;margin:0 4px;">
                <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/youtube@2x.png" width="28" height="28" alt="YouTube" style="display:block;">
              </a>
              <a href="https://2smart.pt/" target="_blank" style="display:inline-block;margin:0 4px;">
                <img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-only-logo-white/website@2x.png" width="28" height="28" alt="Website" style="display:block;">
              </a>
            </div>
            <p style="margin:0;color:rgba(255,255,255,.4);font-size:10px;text-align:center;line-height:1.6;">
              © 2Smart HR · <a href="https://2smart.pt" style="color:rgba(255,255,255,.6);text-decoration:none;">www.2smart.pt</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>

</body>
</html>`;

      // Guardar lead na DB
      let leadId = null;
      try {
        const validOrigens = ["Website", "Referral", "Evento", "Telefone", "LinkedIn", "Outro"];
        const leadDoc = {
          empresa:         company.trim(),
          data:            now.toISOString().split("T")[0],
          contacto:        name.trim(),
          telefone:        phone || "",
          email:           (email || "").toLowerCase().trim(),
          origem:          validOrigens.includes(source) ? source : "Website",
          estado:          "Novo",
          obs: [
            `🏢 ${company || "Empresa não identificada"}`,
            "",
            "═════════════════════════",
            "DADOS DA EMPRESA",
            "═════════════════════════",
            `• NIF: ${nif || "—"}`,
            `• Setor de Atividade: ${sector || "—"}`,
            `• Nº de Colaboradores: ${employeesnumber || "—"}`,
            "",
            "═════════════════════════",
            "MENSAGEM",
            "═════════════════════════",
            message || "Nenhuma mensagem fornecida.",
            "",
          ].join("\n"),
          nif:             nif || "",
          sector:          sector || "",
          employeesnumber: String(employeesnumber),
          newsletter:      Boolean(newsletter),
          source:          "public_contact",
          createdBy:       "public",
          createdAt:       now,
          updatedAt:       now,
        };
        const result = await leadsCollection.insertOne(leadDoc);
        leadId = result.insertedId;
      } catch (dbErr) {
        console.error("[ERROR] POST /api/public/contact — insertOne lead:", dbErr);
      }

      // Enviar emails
      try {
        await transporter.sendMail({
          from:    '"2Smart CRM" <sales@2smart.pt>',
          to:      ["paulo.ferreira@exportech.com.pt", "sales@2smart.pt", "kiosso.silva@exportech.com.pt"],
          subject: `Solicitação de orçamento 2Smart (${name} — ${company})`,
          html:    htmlInterno,
        });
      } catch (mailErr) {
        console.error("[ERROR] POST /api/public/contact — sendMail interno:", mailErr);
      }

      try {
        if (email) {
          await transporter.sendMail({
            from:    '"2Smart CRM" <sales@2smart.pt>',
            to:      email,
            subject: "Solicitação de orçamento 2Smart — Obrigado pelo contacto!",
            html:    htmlConfirmacao,
          });
        }
      } catch (mailErr) {
        console.error("[ERROR] POST /api/public/contact — sendMail confirmação:", mailErr);
      }

      return res.json({ success: true, message: "Pedido recebido com sucesso.", leadId });
    } catch (err) { return handleError(res, 'POST /api/public/contact', err); }
  }

  // ============================================================================
  // ROI CALCULATOR
  // ============================================================================
  if (pathname === "/api/roi-calculator" && method === "POST") {
    try {
      const { name, email, calcData } = body || {};

      if (!name || !name.trim())
        return res.status(400).json({ error: "O campo 'name' é obrigatório." });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !emailRegex.test(email))
        return res.status(400).json({ error: "Email inválido." });

      if (!calcData || typeof calcData !== "object")
        return res.status(400).json({ error: "Dados do cálculo ROI em falta." });

      const cleanName  = name.trim();
      const cleanEmail = email.toLowerCase().trim();
      const now        = new Date();

      // 1) Newsletter upsert
      try {
        await newsletterCollection.updateOne(
          { email: cleanEmail },
          {
            $setOnInsert: { subscribedAt: now },
            $set: { name: cleanName, company: calcData.setor||"", email: cleanEmail, position: "ROI Calculator", updatedAt: now },
          },
          { upsert: true }
        );
      } catch (dbErr) {
        console.error("[ERROR] POST /api/roi-calculator — newsletter upsert:", dbErr);
      }

      // 2) Lead upsert
      try {
        await leadsCollection.updateOne(
          { email: cleanEmail },
          {
            $setOnInsert: { createdAt: now, createdBy: "public" },
            $set: {
              empresa:   calcData.setor || "Calculadora ROI",
              data:      now.toISOString().split("T")[0],
              contacto:  cleanName,
              email:     cleanEmail,
              origem:    "Website",
              estado:    "Novo",
              obs: [
                `Lead gerado via Calculadora ROI`,
                `Colaboradores: ${calcData.numColab}`,
                `Plano: ${calcData.planoLabel}`,
                `Poupança anual estimada: ${new Intl.NumberFormat("pt-PT",{style:"currency",currency:"EUR"}).format(calcData.poupAnual)}`,
                `ROI: ${Math.round(calcData.roi)}%`,
              ].join(" | "),
              roiCalcData: calcData,
              updatedAt:   now,
            },
          },
          { upsert: true }
        );
      } catch (dbErr) {
        console.error("[ERROR] POST /api/roi-calculator — lead upsert:", dbErr);
      }

      // 3) Email ao utilizador
      try {
        const htmlBody = buildRoiEmailHtml({ userName: cleanName, calcData });
        await transporter.sendMail({
          from:    '"2Smart CRM" <sales@2smart.pt>',
          to:      cleanEmail,
          subject: `Os seus resultados ROI — 2Smart HR`,
          html:    htmlBody,
        });
      } catch (mailErr) {
        console.error("[ERROR] POST /api/roi-calculator — sendMail:", mailErr);
      }

      return res.json({ status: "ok", message: "Resultados enviados para o seu email com sucesso!" });
    } catch (err) { return handleError(res, 'POST /api/roi-calculator', err); }
  }

  // ============================================================================
  // PARTNERSHIPS
  // ============================================================================
  if (pathname === "/api/partnerships" && method === "POST") {
    try {
      const { name, email, phone, company, role, employees, tipo, message } = body || {};

      if (!name || !String(name).trim())
        return res.status(400).json({ error: "O campo nome é obrigatório." });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !emailRegex.test(String(email).trim()))
        return res.status(400).json({ error: "O endereço de email é inválido." });

      if (!phone || !String(phone).trim())
        return res.status(400).json({ error: "O campo telefone é obrigatório." });

      const phoneClean = String(phone).trim().replace(/\s/g, "");
      if (!/^[+\d]{7,15}$/.test(phoneClean))
        return res.status(400).json({ error: "O número de telefone não é válido." });

      if (!company || !String(company).trim())
        return res.status(400).json({ error: "O campo empresa é obrigatório." });

      if (!role || !String(role).trim())
        return res.status(400).json({ error: "O campo cargo é obrigatório." });

      const empNum = parseInt(employees, 10);
      if (!employees || isNaN(empNum) || empNum < 1)
        return res.status(400).json({ error: "Indique um número de colaboradores válido." });

      const validTipos = ["Revendedor", "Expert", "Referral"];
      if (!tipo || !validTipos.includes(tipo))
        return res.status(400).json({ error: "Selecione um tipo de parceria válido." });

      const now = new Date();
      const doc = {
        name:      String(name).trim(),
        email:     String(email).toLowerCase().trim(),
        phone:     phoneClean,
        company:   String(company).trim(),
        role:      String(role).trim(),
        employees: empNum,
        tipo,
        message:   message ? String(message).trim() : "",
        createdAt: now,
        updatedAt: now,
      };

      const result = await partnershipsCollection.insertOne(doc);

      try {
        await transporter.sendMail({
          from:    '"2Smart CRM" <sales@2smart.pt>',
          to:      ["kiosso.silva@exportech.com.pt"],
          subject: `Nova candidatura de parceria — ${doc.name} (${doc.company})`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
              <h2 style="color:#1a5cff;margin-bottom:8px;">Nova candidatura de parceria</h2>
              <p style="color:#374151;margin-bottom:20px;">Recebida em ${now.toLocaleString("pt-PT")}</p>
              <table style="width:100%;border-collapse:collapse;">
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;width:140px;">Nome</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.name}</td></tr>
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Email</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.email}</td></tr>
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Telefone</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.phone}</td></tr>
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Empresa</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.company}</td></tr>
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Cargo</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.role}</td></tr>
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Colaboradores</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.employees}</td></tr>
                <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Tipo</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.tipo}</td></tr>
                ${doc.message ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;">Mensagem</td><td style="padding:8px;border:1px solid #e5e7eb;">${doc.message}</td></tr>` : ""}
              </table>
            </div>`,
        });
      } catch (mailErr) {
        console.error("[ERROR] POST /api/partnerships — sendMail interno:", mailErr);
      }

      return res.status(201).json({
        status:  "ok",
        message: "Candidatura recebida com sucesso!",
        partnership: { ...doc, id: result.insertedId, _id: result.insertedId },
      });
    } catch (err) { return handleError(res, 'POST /api/partnerships', err); }
  }

  if (pathname === "/api/partnerships" && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const page  = parseInt(query?.page  || "1",  10);
      const limit = parseInt(query?.limit || "50", 10);
      const skip  = (page - 1) * limit;
      const filter = {};
      if (query?.tipo)   filter.tipo = query.tipo;
      if (query?.search) filter.$or = [
        { name:    { $regex: query.search, $options: "i" } },
        { company: { $regex: query.search, $options: "i" } },
        { email:   { $regex: query.search, $options: "i" } },
      ];
      const items = await partnershipsCollection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      const total = await partnershipsCollection.countDocuments(filter);
      return res.json({ status: "ok", total, partnerships: items.map(p => ({ ...p, id: p._id })) });
    } catch (err) { return handleError(res, 'GET /api/partnerships', err); }
  }

  if (partnershipIdMatch && method === "GET") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      const _id = toObjectId(partnershipIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const partnership = await partnershipsCollection.findOne({ _id });
      if (!partnership) return res.status(404).json({ error: "Candidatura não encontrada" });
      return res.json({ status: "ok", partnership: { ...partnership, id: partnership._id } });
    } catch (err) { return handleError(res, 'GET /api/partnerships/:id', err); }
  }

  if (partnershipIdMatch && method === "DELETE") {
    try {
      const authUser = await requireAuthUser(req, res); if (!authUser) return;
      if (!isMaster(authUser)) return res.status(403).json({ error: "Apenas masters podem eliminar candidaturas" });
      const _id = toObjectId(partnershipIdMatch[1]);
      if (!_id) return res.status(400).json({ error: "ID inválido" });
      const del = await partnershipsCollection.deleteOne({ _id });
      if (!del.deletedCount) return res.status(404).json({ error: "Candidatura não encontrada" });
      return res.json({ status: "ok", message: "Candidatura eliminada com sucesso" });
    } catch (err) { return handleError(res, 'DELETE /api/partnerships/:id', err); }
  }

  // ── Servir ficheiros estáticos do CRM ──────────────────────────────────────
  // Frontend em ../CRM_WEBSITE relativo ao backend
  // Acede via http://localhost:4000/login.html (mesma origem → cookies funcionam)
  if (!pathname.startsWith('/api/')) {
    const FRONTEND_DIR = process.env.FRONTEND_DIR
      || path.join(__dirname, '..', 'CRM_WEBSITE');

    const mimes = {
      '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
      '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
      '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
      '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
      '.webp':'image/webp', '.gif':'image/gif', '.mp4':'video/mp4',
    };

    // / → index.html, /login.html → login.html, etc.
    const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const fullPath = path.join(FRONTEND_DIR, relPath);

    // Segurança: não permite sair do directório
    if (!fullPath.startsWith(path.resolve(FRONTEND_DIR))) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
      // Cache curto para desenvolvimento
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    // Ficheiro não encontrado → tenta index.html (SPA fallback)
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  return res.status(404).json({ error: "Rota não encontrada" });
}

const server = http.createServer(async (req, res) => {
  try {
    await handler(req, res);  
  } catch (err) {
    console.error("[FATAL] Unhandled error in handler:", err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Erro interno do servidor", detail: err?.message }));
    }
  }
});

server.listen(PORT, () => { console.log(`Servidor a correr em http://localhost:${PORT}`); });
