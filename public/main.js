const socket = new WebSocket("ws://192.168.50.147:8081"); 
const roomCode = generateCode();
document.getElementById("roomCode").value = roomCode;

// Track state for annotation editing
let pos = { x: 0, y: 0, z: 0 };
let scale = { x: 1, y: 1, z: 1 };
let rot = { x: 0, y: 0, z: 0 };
let keys = {};
let annotations = {};
let editing = null;
let lastEditing = null; // <--- track previous editing
let editMode = "position";

// Track last sent values for delta calculation
let lastSent = {
  pos: { x: 0, y: 0, z: 0 },
  rot: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 }
};

// Generate random room code
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// On WebSocket open, send the generated room code to the server
socket.onopen = () => {
  console.log("✅ WebSocket connection established!");
  console.log("Sending room code:", roomCode);
  socket.send(JSON.stringify({ client: "web", annotationRoomCode: roomCode }));
};

function generateAnnotationId() {
  return 'AN-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}

function setMode(mode) { editMode = mode; }
function move(key) { handleKey(key); }

/**
 * Always start a NEW annotation at zero for all values.
 * Also reset lastSent state for correct delta computation.
 */
function sendCreate() {
  pos = { x: 0, y: 0, z: 0 };
  rot = { x: 0, y: 0, z: 0 };
  scale = { x: 1, y: 1, z: 1 };
  lastSent = {
    pos: { ...pos },
    rot: { ...rot },
    scale: { ...scale }
  };

  const id = generateAnnotationId();
  const type = document.getElementById("shapeSelector").value;
  const msg = {
    command: "create",
    type,
    annotationId: id,
    position: { ...pos },
    rotation: { ...rot },
    scale: { ...scale }
  };
  annotations[id] = { pos: { ...pos }, rot: { ...rot }, scale: { ...scale }, type };
  editing = id;
  lastEditing = id; // for new annotations
  send(msg);
  renderList();
}

/**
 * When editing an annotation, load its stored values and set lastSent accordingly.
 */
function startEdit(id) {
  if (editing && editing !== id) {
    // Deselect previous annotation
    socket.send(JSON.stringify({
      command: "deselect",
      annotationId: editing
    }));
  }
  editing = id;
  lastEditing = id;
  const ann = annotations[id];
  pos = { ...ann.pos };
  rot = { ...ann.rot };
  scale = { ...ann.scale };
  lastSent = {
    pos: { ...pos },
    rot: { ...rot },
    scale: { ...scale }
  };
  renderList();

  // --- Send select event to Unity
  socket.send(JSON.stringify({
    command: "select",
    annotationId: id
  }));
}


// Helper to check if object has nonzero value
function hasNonZero(obj) {
  return Object.values(obj).some(v => Math.abs(v) > 1e-6);
}

// Calculate delta and send only if there's a change
function sendUpdate() {
  if (!editing) return;

  // Calculate delta
  const posDelta = {
    x: pos.x - lastSent.pos.x,
    y: pos.y - lastSent.pos.y,
    z: pos.z - lastSent.pos.z
  };
  const rotDelta = {
    x: rot.x - lastSent.rot.x,
    y: rot.y - lastSent.rot.y,
    z: rot.z - lastSent.rot.z
  };
  const scaleDelta = {
    x: scale.x - lastSent.scale.x,
    y: scale.y - lastSent.scale.y,
    z: scale.z - lastSent.scale.z
  };

  // Only send if at least one value is non-zero
  if (hasNonZero(posDelta) || hasNonZero(rotDelta) || hasNonZero(scaleDelta)) {
    const msg = {
      command: "update",
      annotationId: editing,
      position: posDelta,
      rotation: rotDelta,
      scale: scaleDelta
    };
    send(msg);

    // Update lastSent to new values
    lastSent = {
      pos: { ...pos },
      rot: { ...rot },
      scale: { ...scale }
    };
  }
}

function sendDelete(id) {
  // If deleting the currently edited annotation, also send deselect
  if (editing === id) {
    socket.send(JSON.stringify({
      command: "deselect",
      annotationId: id
    }));
    editing = null;
    lastEditing = null;
  }
  const msg = { command: "delete", annotationId: id };
  send(msg);
  delete annotations[id];
  renderList();
}

function send(msg) {
  socket.send(JSON.stringify(msg));
}

function renderList() {
  const list = document.getElementById("annotationList");
  list.innerHTML = "<h4>Annotations</h4>";
  for (const id in annotations) {
    const item = document.createElement("div");
    item.className = "annotation-item" + (editing === id ? " active" : "");
    item.innerHTML = `
      ${id}
      <button onclick="startEdit('${id}')">Edit</button>
      <button onclick="sendDelete('${id}')">Delete</button>
    `;
    list.appendChild(item);
  }
}

document.addEventListener("keydown", e => {
  const key = e.key.toLowerCase();
  if (key === "escape") {
    if (editing) {
      // On ESC, deselect in Unity
      socket.send(JSON.stringify({
        command: "deselect",
        annotationId: editing
      }));
    }
    editing = null;
    renderList();
    return;
  }
  keys[key] = true;
});

document.addEventListener("keyup", e => keys[e.key.toLowerCase()] = false);

document.addEventListener("wheel", e => {
  if (!editing) return;
  pos.z += e.deltaY * 0.01;
  annotations[editing].pos = { ...pos };
  sendUpdate();
});

function handleKey(k) {
  if (!editing) return;
  let sens = parseFloat(document.getElementById("sensitivity").value);
  let changed = false;
  if (editMode === "position") {
    if (k === "w") { pos.y += sens; changed = true; }
    if (k === "s") { pos.y -= sens; changed = true; }
    if (k === "a") { pos.x -= sens; changed = true; }
    if (k === "d") { pos.x += sens; changed = true; }
    if (changed) annotations[editing].pos = { ...pos };
  } else if (editMode === "rotation") {
    if (k === "w") { rot.x += sens * 10; changed = true; }
    if (k === "s") { rot.x -= sens * 10; changed = true; }
    if (k === "a") { rot.y -= sens * 10; changed = true; }
    if (k === "d") { rot.y += sens * 10; changed = true; }
    if (changed) annotations[editing].rot = { ...rot };
  } else if (editMode === "scale") {
    if (k === "w") { scale.y += sens; changed = true; }
    if (k === "s") { scale.y -= sens; changed = true; }
    if (k === "a") { scale.x -= sens; changed = true; }
    if (k === "d") { scale.x += sens; changed = true; }
    if (changed) annotations[editing].scale = { ...scale };
  }
  if (changed) sendUpdate();
}

setInterval(() => {
  if (!editing) return;
  ["w", "a", "s", "d"].forEach(k => {
    if (keys[k]) handleKey(k);
  });
}, 50);

// ---- File Upload Handling ----

document.getElementById("uploadForm").addEventListener("submit", async function (e) {
  e.preventDefault();

  const form = e.target;
  const type = document.getElementById("uploadType").value;
  const formData = new FormData(form);

  // ADD ROOM CODE FOR BACKEND
  formData.append('annotationRoomCode', roomCode);

  let endpoint = "/upload/" + type;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    const output = document.getElementById("uploadResult");

    if (data.success) {
      if (data.type === "pdf") {
        output.innerHTML = `<h4>📄 PDF with ${data.pageCount} pages</h4>`;
        data.urls.forEach((url, idx) => {
          output.innerHTML += `<div><img class="thumbnail" src="${url}" alt="Page ${idx + 1}"></div>`;
        });
      } else if (data.type === "image") {
        output.innerHTML = `<h4>🖼 Uploaded Image</h4><img class="thumbnail" src="${data.url}">`;
        console.log("📤 Sent Image to Unity:", data.url);
        socket.send(JSON.stringify({
          type: "image",
          url: data.url,
          timestamp: new Date().toISOString()
        }));
      } else if (data.type === "video") {
        output.innerHTML = `<h4>🎞 Uploaded Video</h4><video class="thumbnail" controls src="${data.url}"></video>`;
      }
    } else {
      output.innerHTML = "❌ Upload failed";
    }
  } catch (error) {
    console.error("Error uploading file:", error);
  }
});
