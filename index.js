import express from 'express';
import cors from 'cors';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/test', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email y appPassword son requeridos' });
  }
  try {
    const result = await testConnection(email, appPassword);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/connect', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email y appPassword son requeridos' });
  }
  try {
    const result = await testConnection(email, appPassword);
    res.json({ success: true, message: 'Conexión IMAP exitosa', email, ...result });
  } catch (error) {
    res.status(400).json({ error: `Error de conexión: ${error.message}` });
  }
});

app.post('/fetch', async (req, res) => {
  const { email, appPassword, limit = 100, receivedAfter, receivedBefore } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email y appPassword son requeridos' });
  }
  try {
    const emails = await fetchEmails(email, appPassword, { limit, receivedAfter, receivedBefore });
    res.json({ success: true, count: emails.length, emails });
  } catch (error) {
    res.status(400).json({ error: `Error al obtener emails: ${error.message}` });
  }
});

function createImapConnection(email, appPassword) {
  return new Imap({
    user: email,
    password: appPassword,
    host: 'imap.mail.yahoo.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 30000,
    connTimeout: 30000
  });
}

function testConnection(email, appPassword) {
  return new Promise((resolve, reject) => {
    const imap = createImapConnection(email, appPassword);
    imap.once('ready', () => {
      imap.getBoxes((err, boxes) => {
        if (err) { imap.end(); return reject(err); }
        imap.end();
        resolve({ connected: true, folders: Object.keys(boxes), message: 'Conexión verificada correctamente' });
      });
    });
    imap.once('error', (err) => reject(new Error(`Error IMAP: ${err.message}`)));
    imap.connect();
  });
}

function fetchEmails(email, appPassword, options = {}) {
  const { limit = 100, receivedAfter, receivedBefore } = options;
  return new Promise((resolve, reject) => {
    const imap = createImapConnection(email, appPassword);
    const emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { imap.end(); return reject(err); }
        const searchCriteria = buildSearchCriteria(receivedAfter, receivedBefore);
        imap.search(searchCriteria, (err, results) => {
          if (err) { imap.end(); return reject(err); }
          if (results.length === 0) { imap.end(); return resolve([]); }
          const messagesToFetch = results.slice(-limit).reverse();
          const fetch = imap.fetch(messagesToFetch, {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
            struct: true
          });
          fetch.on('message', (msg, seqno) => {
            const emailData = { seqno, uid: null };
            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
              stream.once('end', () => {
                if (info.which.includes('HEADER')) emailData.headers = Imap.parseHeader(buffer);
                else emailData.textPreview = buffer.substring(0, 300);
              });
            });
            msg.once('attributes', (attrs) => {
              emailData.uid = attrs.uid;
              emailData.flags = attrs.flags;
              emailData.date = attrs.date;
              emailData.struct = attrs.struct;
            });
            msg.once('end', () => {
              const parsed = parseEmailData(emailData);
              if (parsed) emails.push(parsed);
            });
          });
          fetch.once('error', (err) => { imap.end(); reject(err); });
          fetch.once('end', () => { imap.end(); resolve(emails); });
        });
      });
    });
    imap.once('error', (err) => reject(new Error(`Error IMAP: ${err.message}`)));
    imap.connect();
  });
}

function buildSearchCriteria(receivedAfter, receivedBefore) {
  const criteria = ['ALL'];
  if (receivedAfter) criteria.push(['SINCE', formatImapDate(new Date(receivedAfter))]);
  if (receivedBefore) {
    const beforeDate = new Date(receivedBefore);
    beforeDate.setDate(beforeDate.getDate() + 1);
    criteria.push(['BEFORE', formatImapDate(beforeDate)]);
  }
  return criteria;
}

function formatImapDate(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()}-${months[date.getMonth()]}-${date.getFullYear()}`;
}

function parseEmailData(emailData) {
  try {
    const headers = emailData.headers || {};
    const fromHeader = headers.from?.[0] || '';
    const subject = headers.subject?.[0] || '(Sin asunto)';
    let fromName = '', fromEmail = '';
    const fromMatch = fromHeader.match(/^(?:"?([^"]*)"?\s*)?<?([^>]+@[^>]+)>?$/);
    if (fromMatch) { fromName = fromMatch[1]?.trim() || ''; fromEmail = fromMatch[2]?.trim() || fromHeader; }
    else fromEmail = fromHeader;
    const hasAttachments = checkForAttachments(emailData.struct);
    let snippet = (emailData.textPreview || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);
    const isPossibleInvoice = detectPossibleInvoice(subject, snippet, fromEmail, hasAttachments);
    return {
      message_uid: `<${emailData.uid}@yahoo.imap>`,
      subject, from_name: fromName, from_email: fromEmail,
      received_at: new Date(headers.date?.[0] || emailData.date).toISOString(),
      snippet, has_attachments: hasAttachments, is_possible_invoice: isPossibleInvoice
    };
  } catch { return null; }
}

function checkForAttachments(struct) {
  if (!struct) return false;
  const check = (parts) => {
    if (!Array.isArray(parts)) return false;
    for (const part of parts) {
      if (Array.isArray(part) && check(part)) return true;
      if (typeof part === 'object' && part.disposition?.type?.toLowerCase() === 'attachment') return true;
    }
    return false;
  };
  return check(struct);
}

function detectPossibleInvoice(subject, snippet, fromEmail, hasAttachments) {
  const keywords = ['factura', 'invoice', 'recibo', 'receipt', 'pago', 'payment', 'cobro', 'cargo', 'importe', 'total', 'iva', 'vat'];
  const text = `${subject} ${snippet} ${fromEmail}`.toLowerCase();
  if (hasAttachments) return keywords.some(k => text.includes(k));
  const strong = ['factura', 'invoice', 'recibo', 'receipt'];
  return strong.some(k => text.includes(k));
}

app.listen(PORT, () => console.log(`Yahoo IMAP Server running on port ${PORT}`));
