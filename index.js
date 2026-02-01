import express from 'express';
import cors from 'cors';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test IMAP connection
app.post('/test', async (req, res) => {
  const { email, appPassword } = req.body;
  
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email y appPassword son requeridos' });
  }

  try {
    const result = await testConnection(email, appPassword);
    res.json(result);
  } catch (error) {
    console.error('Test connection error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Connect and verify credentials
app.post('/connect', async (req, res) => {
  const { email, appPassword } = req.body;
  
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email y appPassword son requeridos' });
  }

  try {
    const result = await testConnection(email, appPassword);
    res.json({ 
      success: true, 
      message: 'Conexión IMAP exitosa',
      email,
      ...result 
    });
  } catch (error) {
    console.error('Connect error:', error);
    res.status(400).json({ error: `Error de conexión: ${error.message}` });
  }
});

// Fetch emails with date range
app.post('/fetch', async (req, res) => {
  const { email, appPassword, limit = 100, receivedAfter, receivedBefore } = req.body;
  
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email y appPassword son requeridos' });
  }

  try {
    console.log(`Fetching emails for ${email}`, { limit, receivedAfter, receivedBefore });
    const emails = await fetchEmails(email, appPassword, { limit, receivedAfter, receivedBefore });
    res.json({ 
      success: true, 
      count: emails.length,
      emails 
    });
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(400).json({ error: `Error al obtener emails: ${error.message}` });
  }
});

// Fetch attachments for specific email UIDs
app.post('/fetch-attachments', async (req, res) => {
  const { email, appPassword, messageUids } = req.body;
  
  if (!email || !appPassword || !messageUids || !Array.isArray(messageUids)) {
    return res.status(400).json({ error: 'Email, appPassword y messageUids son requeridos' });
  }

  try {
    console.log(`Fetching attachments for ${messageUids.length} messages`);
    const attachments = await fetchAttachments(email, appPassword, messageUids);
    res.json({ 
      success: true, 
      count: attachments.length,
      attachments 
    });
  } catch (error) {
    console.error('Fetch attachments error:', error);
    res.status(400).json({ error: `Error al obtener adjuntos: ${error.message}` });
  }
});

// Helper: Create IMAP connection
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

// Helper: Test connection
function testConnection(email, appPassword) {
  return new Promise((resolve, reject) => {
    const imap = createImapConnection(email, appPassword);
    
    imap.once('ready', () => {
      imap.getBoxes((err, boxes) => {
        if (err) {
          imap.end();
          return reject(err);
        }
        
        const folderNames = Object.keys(boxes);
        imap.end();
        resolve({ 
          connected: true, 
          folders: folderNames,
          message: 'Conexión verificada correctamente'
        });
      });
    });

    imap.once('error', (err) => {
      reject(new Error(`Error IMAP: ${err.message}`));
    });

    imap.once('end', () => {
      console.log('Connection ended');
    });

    imap.connect();
  });
}

// Helper: Fetch emails
function fetchEmails(email, appPassword, options = {}) {
  const { limit = 100, receivedAfter, receivedBefore } = options;
  
  return new Promise((resolve, reject) => {
    const imap = createImapConnection(email, appPassword);
    const emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        console.log(`Inbox has ${box.messages.total} messages`);

        // Build search criteria
        const searchCriteria = buildSearchCriteria(receivedAfter, receivedBefore);
        console.log('Search criteria:', JSON.stringify(searchCriteria));

        imap.search(searchCriteria, (err, results) => {
          if (err) {
            imap.end();
            return reject(err);
          }

          console.log(`Found ${results.length} matching messages`);

          if (results.length === 0) {
            imap.end();
            return resolve([]);
          }

          // Get the most recent messages up to limit
          const messagesToFetch = results.slice(-limit).reverse();
          console.log(`Fetching ${messagesToFetch.length} messages`);

          const fetch = imap.fetch(messagesToFetch, {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
            struct: true
          });

          fetch.on('message', (msg, seqno) => {
            const emailData = { seqno, uid: null };
            
            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });
              stream.once('end', () => {
                if (info.which.includes('HEADER')) {
                  emailData.headers = Imap.parseHeader(buffer);
                } else {
                  emailData.textPreview = buffer.substring(0, 300);
                }
              });
            });

            msg.once('attributes', (attrs) => {
              emailData.uid = attrs.uid;
              emailData.flags = attrs.flags;
              emailData.date = attrs.date;
              emailData.struct = attrs.struct;
            });

            msg.once('end', () => {
              // Parse the email data
              const parsed = parseEmailData(emailData);
              if (parsed) {
                emails.push(parsed);
              }
            });
          });

          fetch.once('error', (err) => {
            console.error('Fetch error:', err);
            imap.end();
            reject(err);
          });

          fetch.once('end', () => {
            console.log(`Fetched ${emails.length} emails successfully`);
            imap.end();
            resolve(emails);
          });
        });
      });
    });

    imap.once('error', (err) => {
      reject(new Error(`Error IMAP: ${err.message}`));
    });

    imap.connect();
  });
}

// Helper: Build search criteria for IMAP
function buildSearchCriteria(receivedAfter, receivedBefore) {
  const criteria = ['ALL'];
  
  if (receivedAfter) {
    const afterDate = new Date(receivedAfter);
    // IMAP SINCE uses format: DD-MMM-YYYY
    const sinceStr = formatImapDate(afterDate);
    criteria.push(['SINCE', sinceStr]);
    console.log(`Adding SINCE: ${sinceStr}`);
  }
  
  if (receivedBefore) {
    const beforeDate = new Date(receivedBefore);
    // Add 1 day because BEFORE is exclusive
    beforeDate.setDate(beforeDate.getDate() + 1);
    const beforeStr = formatImapDate(beforeDate);
    criteria.push(['BEFORE', beforeStr]);
    console.log(`Adding BEFORE: ${beforeStr}`);
  }
  
  return criteria.length === 1 ? criteria : criteria;
}

// Helper: Format date for IMAP (DD-MMM-YYYY)
function formatImapDate(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

// Helper: Parse email data into structured format
function parseEmailData(emailData) {
  try {
    const headers = emailData.headers || {};
    const fromHeader = headers.from?.[0] || '';
    const subject = headers.subject?.[0] || '(Sin asunto)';
    const dateHeader = headers.date?.[0] || emailData.date;
    
    // Parse from header
    let fromName = '';
    let fromEmail = '';
    const fromMatch = fromHeader.match(/^(?:"?([^"]*)"?\s*)?<?([^>]+@[^>]+)>?$/);
    if (fromMatch) {
      fromName = fromMatch[1]?.trim() || '';
      fromEmail = fromMatch[2]?.trim() || fromHeader;
    } else {
      fromEmail = fromHeader;
    }

    // Check for attachments in structure
    const hasAttachments = checkForAttachments(emailData.struct);

    // Create snippet from text preview
    let snippet = emailData.textPreview || '';
    // Clean up the snippet
    snippet = snippet
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/\s+/g, ' ')    // Normalize whitespace
      .trim()
      .substring(0, 200);

    // Detect possible invoice
    const isPossibleInvoice = detectPossibleInvoice(subject, snippet, fromEmail, hasAttachments);

    return {
      message_uid: `<${emailData.uid}@yahoo.imap>`,
      subject,
      from_name: fromName,
      from_email: fromEmail,
      received_at: new Date(dateHeader || emailData.date).toISOString(),
      snippet,
      has_attachments: hasAttachments,
      is_possible_invoice: isPossibleInvoice
    };
  } catch (error) {
    console.error('Error parsing email:', error);
    return null;
  }
}

// Helper: Check for attachments in email structure
function checkForAttachments(struct) {
  if (!struct) return false;
  
  const check = (parts) => {
    if (!Array.isArray(parts)) return false;
    
    for (const part of parts) {
      if (Array.isArray(part)) {
        if (check(part)) return true;
      } else if (typeof part === 'object' && part.disposition) {
        if (part.disposition.type?.toLowerCase() === 'attachment') {
          return true;
        }
      }
    }
    return false;
  };
  
  return check(struct);
}

// Helper: Detect if email might contain an invoice
function detectPossibleInvoice(subject, snippet, fromEmail, hasAttachments) {
  const invoiceKeywords = [
    'factura', 'invoice', 'recibo', 'receipt', 'pago', 'payment',
    'cobro', 'cargo', 'importe', 'total', 'iva', 'vat', 'tax',
    'pedido', 'order', 'compra', 'purchase', 'suscripción', 'subscription'
  ];
  
  const combinedText = `${subject} ${snippet} ${fromEmail}`.toLowerCase();
  
  // Higher chance if has attachments and keywords
  if (hasAttachments) {
    return invoiceKeywords.some(keyword => combinedText.includes(keyword));
  }
  
  // Check for PDF attachment indicators
  if (combinedText.includes('.pdf') || combinedText.includes('adjunto')) {
    return invoiceKeywords.some(keyword => combinedText.includes(keyword));
  }
  
  // Strong keywords that indicate invoice even without attachment
  const strongKeywords = ['factura', 'invoice', 'recibo', 'receipt'];
  return strongKeywords.some(keyword => combinedText.includes(keyword));
}

// Helper: Fetch attachments for specific messages
function fetchAttachments(email, appPassword, messageUids) {
  return new Promise((resolve, reject) => {
    const imap = createImapConnection(email, appPassword);
    const results = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, async (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        // Convert message UIDs from format "<UID@yahoo.imap>" to numeric UIDs
        const numericUids = messageUids.map(uid => {
          const match = uid.match(/<(\d+)@/);
          return match ? parseInt(match[1], 10) : null;
        }).filter(uid => uid !== null);

        if (numericUids.length === 0) {
          imap.end();
          return resolve([]);
        }

        console.log(`Looking for UIDs: ${numericUids.join(', ')}`);

        // CRITICAL: Use UID-based fetch (third parameter = true means use UID)
        // The imap library's fetch() method defaults to sequence numbers, not UIDs
        // We must pass 'true' as third parameter to fetch by UID
        const fetch = imap.fetch(numericUids, {
          bodies: '',
          struct: true
        }, true);  // <-- This 'true' tells imap to use UIDs instead of sequence numbers

        let pendingMessages = numericUids.length;

        fetch.on('message', (msg, seqno) => {
          let buffer = Buffer.alloc(0);
          let messageUid = null;
          let messageStruct = null;

          msg.on('body', (stream) => {
            const chunks = [];
            stream.on('data', (chunk) => {
              chunks.push(chunk);
            });
            stream.once('end', () => {
              buffer = Buffer.concat(chunks);
            });
          });

          msg.once('attributes', (attrs) => {
            messageUid = attrs.uid;
            messageStruct = attrs.struct;
          });

          msg.once('end', async () => {
            try {
              // Parse the full message
              const parsed = await simpleParser(buffer);
              
              const messageResult = {
                message_uid: `<${messageUid}@yahoo.imap>`,
                subject: parsed.subject,
                from: parsed.from?.text || '',
                date: parsed.date?.toISOString(),
                html_body: parsed.html || null,
                text_body: parsed.text || null,
                attachments: []
              };

              // Process attachments
              if (parsed.attachments && parsed.attachments.length > 0) {
                for (const att of parsed.attachments) {
                  // Only include PDFs and images for invoice processing
                  const isPdf = att.contentType === 'application/pdf' || 
                                att.filename?.toLowerCase().endsWith('.pdf');
                  const isImage = att.contentType?.startsWith('image/');
                  
                  if (isPdf || isImage) {
                    messageResult.attachments.push({
                      filename: att.filename || 'attachment',
                      contentType: att.contentType,
                      size: att.size,
                      // Base64 encode the content
                      content: att.content.toString('base64')
                    });
                    console.log(`Found attachment: ${att.filename} (${att.contentType}, ${att.size} bytes)`);
                  }
                }
              }

              results.push(messageResult);
            } catch (parseErr) {
              console.error(`Error parsing message ${messageUid}:`, parseErr);
            }

            pendingMessages--;
            if (pendingMessages === 0) {
              imap.end();
            }
          });
        });

        fetch.once('error', (err) => {
          console.error('Fetch attachments error:', err);
          imap.end();
          reject(err);
        });

        fetch.once('end', () => {
          // Wait a bit for all parsing to complete
          setTimeout(() => {
            if (pendingMessages > 0) {
              console.log(`Still waiting for ${pendingMessages} messages to parse...`);
            }
          }, 100);
        });
      });
    });

    imap.once('error', (err) => {
      reject(new Error(`Error IMAP: ${err.message}`));
    });

    imap.once('end', () => {
      console.log(`Fetched ${results.length} messages with attachments`);
      resolve(results);
    });

    imap.connect();
  });
}

app.listen(PORT, () => {
  console.log(`Yahoo IMAP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

