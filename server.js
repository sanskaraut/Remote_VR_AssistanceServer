require('dotenv').config();
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const net = require('net');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// ENV VARS
const PORT_HTTP = parseInt(process.env.PORT_HTTP || '5500', 10);
const PORT_WS = parseInt(process.env.PORT_WS || '8081', 10);
const USE_S3 = process.env.USE_S3 === 'true';
const UPLOADS_PORT = parseInt(process.env.UPLOADS_PORT || '3001', 10);
const UPLOADS_HOST = process.env.UPLOADS_HOST || 'http://localhost';
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const NGROK_URL = process.env.NGROK_URL;
const PUBLIC_IP = process.env.PUBLIC_IP || 'YOUR_EC2_PUBLIC_IP';

// Utility to find a free port (optional, but sticking to your provided port if possible)
function getAvailablePort(defaultPort, cb) {
  const server = net.createServer();
  let called = false;

  server.on('error', () => {
    server.listen(0);
  });

  server.on('listening', () => {
    if (called) return;
    called = true;
    const port = server.address() ? server.address().port : defaultPort;
    server.close(() => cb(port));
  });

  server.listen(defaultPort);
}

let s3;
if (USE_S3) {
  s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

const upload = multer({ dest: 'uploads/tmp' });

// Room management
const annotationRooms = {};

function getRoomUploadDir(roomCode, type) {
  return path.join(__dirname, 'uploads', roomCode, type);
}

function getPublicUrl(roomCode, type, fileName) {
  if (USE_S3) {
    return `https://${AWS_S3_BUCKET}.s3.amazonaws.com/${roomCode}/${type}/${fileName}`;
  }
  if (NGROK_URL) {
    return `${NGROK_URL}/uploads/${roomCode}/${type}/${fileName}`;
  }
  return `${UPLOADS_HOST}:${UPLOADS_PORT}/uploads/${roomCode}/${type}/${fileName}`;
}

// --- Express for Uploads API only ---
const app = express();

// No app.use(express.static(...)) — NO FRONTEND HOSTING

// --- IMAGE UPLOAD ROUTE ---
app.post('/upload/image', upload.single('file'), async (req, res) => {
  const file = req.file;
  const roomCode = (req.body.annotationRoomCode || '').toUpperCase();
  if (!roomCode) {
    console.error("[IMAGE] Missing annotationRoomCode");
    return res.status(400).json({ success: false, message: 'Missing annotationRoomCode' });
  }

  const fileName = `${uuidv4()}-${file.originalname}`;
  let url = "";

  try {
    if (USE_S3) {
      const uploadParams = {
        Bucket: AWS_S3_BUCKET,
        Key: `${roomCode}/images/${fileName}`,
        Body: fs.readFileSync(file.path),
        ContentType: file.mimetype,
      };
      await s3.send(new PutObjectCommand(uploadParams));
      url = `https://${AWS_S3_BUCKET}.s3.amazonaws.com/${roomCode}/images/${fileName}`;
      console.log(`[IMAGE] Uploaded to S3: ${url}`);
      fs.unlinkSync(file.path);
    } else {
      const destDir = getRoomUploadDir(roomCode, 'images');
      fs.mkdirSync(destDir, { recursive: true });
      const outPath = path.join(destDir, fileName);
      fs.renameSync(file.path, outPath);
      url = getPublicUrl(roomCode, 'images', fileName);
      console.log(`[IMAGE] Saved locally: ${url}`);
    }

    const fileMessage = {
      type: 'file',
      fileType: 'image',
      url,
      timestamp: new Date().toISOString(),
    };
    if (annotationRooms[roomCode]) {
      annotationRooms[roomCode].unity.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(fileMessage));
      });
    }
    return res.json({ success: true, type: 'file', fileType: 'image', url });
  } catch (err) {
    console.error(`[IMAGE] Error:`, err);
    return res.status(500).json({ success: false, message: "Image upload failed", error: err.message });
  }
});

// --- VIDEO UPLOAD ROUTE ---
app.post('/upload/video', upload.single('file'), async (req, res) => {
  const file = req.file;
  const roomCode = (req.body.annotationRoomCode || '').toUpperCase();
  if (!roomCode) {
    console.error("[VIDEO] Missing annotationRoomCode");
    return res.status(400).json({ success: false, message: 'Missing annotationRoomCode' });
  }

  const fileName = `${uuidv4()}-${file.originalname}`;
  let url = "";

  try {
    if (USE_S3) {
      const uploadParams = {
        Bucket: AWS_S3_BUCKET,
        Key: `${roomCode}/videos/${fileName}`,
        Body: fs.readFileSync(file.path),
        ContentType: file.mimetype,
      };
      await s3.send(new PutObjectCommand(uploadParams));
      url = `https://${AWS_S3_BUCKET}.s3.amazonaws.com/${roomCode}/videos/${fileName}`;
      console.log(`[VIDEO] Uploaded to S3: ${url}`);
      fs.unlinkSync(file.path);
    } else {
      const destDir = getRoomUploadDir(roomCode, 'videos');
      fs.mkdirSync(destDir, { recursive: true });
      const outPath = path.join(destDir, fileName);
      fs.renameSync(file.path, outPath);
      url = getPublicUrl(roomCode, 'videos', fileName);
      console.log(`[VIDEO] Saved locally: ${url}`);
    }

    const fileMessage = {
      type: 'file',
      fileType: 'video',
      url,
      timestamp: new Date().toISOString(),
    };
    if (annotationRooms[roomCode]) {
      annotationRooms[roomCode].unity.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(fileMessage));
      });
    }
    return res.json({ success: true, type: 'file', fileType: 'video', url });
  } catch (err) {
    console.error(`[VIDEO] Error:`, err);
    return res.status(500).json({ success: false, message: "Video upload failed", error: err.message });
  }
});

// --- PDF UPLOAD & CONVERT ---
app.post('/upload/pdf', upload.single('file'), async (req, res) => {
  const file = req.file;
  const roomCode = (req.body.annotationRoomCode || '').toUpperCase();
  if (!roomCode) {
    console.error("[PDF] Missing annotationRoomCode");
    return res.status(400).json({ success: false, message: 'Missing annotationRoomCode' });
  }

  const pdfId = uuidv4();
  const outputDir = path.join(getRoomUploadDir(roomCode, 'pdf'), pdfId);
  fs.mkdirSync(outputDir, { recursive: true });

  const cmd = `pdftoppm "${file.path}" "${outputDir}/page" -png`;
  console.log(`[PDF] Running command: ${cmd}`);

  exec(cmd, async (err, stdout, stderr) => {
    if (err) {
      console.error(`[PDF] PDF conversion failed:`, err, stderr);
      return res.status(500).json({
        success: false,
        message: "PDF conversion failed",
        error: err.message,
        stderr: stderr,
      });
    }
    const pages = fs.readdirSync(outputDir).filter(f => f.endsWith('.png')).sort();
    const urls = [];
    console.log(`[PDF] Converted ${pages.length} pages for room ${roomCode}`);

    for (const page of pages) {
      const pagePath = path.join(outputDir, page);
      if (USE_S3) {
        const s3Key = `${roomCode}/pdf/${pdfId}/${page}`;
        const fileBuffer = fs.readFileSync(pagePath);
        const uploadParams = {
          Bucket: AWS_S3_BUCKET,
          Key: s3Key,
          Body: fileBuffer,
          ContentType: 'image/png',
        };
        try {
          await s3.send(new PutObjectCommand(uploadParams));
          urls.push(`https://${AWS_S3_BUCKET}.s3.amazonaws.com/${s3Key}`);
          console.log(`[PDF] Uploaded page to S3: ${s3Key}`);
          fs.unlinkSync(pagePath);
        } catch (err) {
          console.error(`[PDF] Error uploading PDF page to S3:`, err);
          return res.status(500).json({ success: false, message: "S3 upload failed", error: err.message });
        }
      } else {
        const localUrl = getPublicUrl(roomCode, `pdf/${pdfId}`, page);
        const finalPath = path.join(outputDir, page);
        fs.renameSync(pagePath, finalPath);
        urls.push(localUrl);
        console.log(`[PDF] Saved PDF page locally: ${localUrl}`);
      }
    }
    fs.unlinkSync(file.path);

    const fileMessage = {
      type: 'file',
      fileType: 'pdf',
      urls,
      pageCount: urls.length,
      pdfId,
      roomCode,
      timestamp: new Date().toISOString(),
    };

    if (annotationRooms[roomCode]) {
      annotationRooms[roomCode].unity.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(fileMessage));
      });
    }
    return res.json({ success: true, type: 'pdf', urls, pageCount: urls.length, pdfId });
  });
});

// ---- Main HTTP Server (NO STATIC) ----
getAvailablePort(PORT_HTTP, (actualPort) => {
  const server = http.createServer(app);
  server.listen(actualPort, '0.0.0.0', () => {
    console.log(`🌐 HTTP/API server running at: http://${PUBLIC_IP}:${actualPort}`);
    console.log(`\nUse this URL in your browser or API clients.`);
  });

  // ---- WebSocket Server ----
  getAvailablePort(PORT_WS, (actualWsPort) => {
    const wss = new WebSocket.Server({ port: actualWsPort, host: '0.0.0.0' });
    console.log(`🚀 WebSocket server running at: ws://${PUBLIC_IP}:${actualWsPort}`);
    console.log(`\n🔗 Use this WebSocket URL in your frontend/Unity: "ws://${PUBLIC_IP}:${actualWsPort}"`);
    console.log('Make sure your EC2 security group allows inbound TCP on this port!');

    // ---- ROOM MANAGEMENT ----
    wss.on('connection', (ws) => {
      let annotationRoomCode = null;
      let clientType = null;

      ws.on('message', (message) => {
        try {
          const msg = JSON.parse(message);

          // Web client joins room
          if (msg.client === 'web' && msg.annotationRoomCode) {
            clientType = 'web';
            annotationRoomCode = msg.annotationRoomCode.toUpperCase();
            if (!annotationRooms[annotationRoomCode]) {
              annotationRooms[annotationRoomCode] = { unity: new Set(), web: new Set() };
            }
            annotationRooms[annotationRoomCode].web.add(ws);
            ws.send(JSON.stringify({ type: 'room_created', annotationRoomCode }));
            return;
          }
          // Unity client joins room
          if (msg.client === 'unity' && msg.annotationRoomCode) {
            clientType = 'unity';
            annotationRoomCode = msg.annotationRoomCode.toUpperCase();
            if (!annotationRooms[annotationRoomCode]) {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid annotationRoomCode' }));
              ws.close();
              return;
            }
            annotationRooms[annotationRoomCode].unity.add(ws);
            ws.send(JSON.stringify({ type: 'room_joined', annotationRoomCode }));
            return;
          }
          // Forward web-to-unity in this room only
          if (clientType === 'web' && annotationRoomCode && annotationRooms[annotationRoomCode]) {
            annotationRooms[annotationRoomCode].unity.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
            });
          }
        } catch (err) {
          console.error('❌ Failed to parse message:', err);
        }
      });

      ws.on('close', () => {
        if (annotationRoomCode && annotationRooms[annotationRoomCode]) {
          if (clientType === 'unity') annotationRooms[annotationRoomCode].unity.delete(ws);
          if (clientType === 'web') annotationRooms[annotationRoomCode].web.delete(ws);

          if (
            annotationRooms[annotationRoomCode].unity.size === 0 &&
            annotationRooms[annotationRoomCode].web.size === 0
          ) {
            if (!USE_S3) {
              const dir = path.join(__dirname, 'uploads', annotationRoomCode);
              fs.rm(dir, { recursive: true, force: true }, (err) => {
                if (err) console.error(`Error cleaning up uploads for ${annotationRoomCode}:`, err);
                else console.log(`🧹 Deleted uploads for room: ${annotationRoomCode}`);
              });
            }
            delete annotationRooms[annotationRoomCode];
            console.log(`🧹 Room ${annotationRoomCode} deleted`);
          }
        }
      });
    });
  });
});

// ---- Separate Static File Server for Uploads (local mode only) ----
if (!USE_S3) {
  const uploadsApp = express();
  const uploadsPath = path.join(__dirname, 'uploads');
  uploadsApp.use('/uploads', express.static(uploadsPath));
  uploadsApp.listen(UPLOADS_PORT, '0.0.0.0', () => {
    if (NGROK_URL) {
      console.log(`🗂️ Uploads file server running at ${NGROK_URL}/uploads/`);
    }
    console.log(`🗂️ Static folder being served: ${uploadsPath}`);
  });
}
