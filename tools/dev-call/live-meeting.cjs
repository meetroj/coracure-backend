// Local-only standalone LiveKit meeting. Run from the repository root.
require('dotenv').config({ quiet: true });
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');

const url = process.env.LIVEKIT_URL;
const roomName = `coracure-live-${Date.now()}`;
const api = new RoomServiceClient(url.replace(/^ws/, 'http'), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Coracure live meeting</title>
<script src="/livekit-client.js"></script>
<style>body{font:16px system-ui;background:#101827;color:#fff;margin:32px}button{padding:12px;margin:5px;cursor:pointer}video{width: min(45vw,640px);border-radius:12px;margin:8px}#status{padding:16px 0}</style></head>
<body><h1>Coracure live meeting</h1><p>${roomName}</p>
<button id="join">Join meeting</button><button id="mic" disabled>Enable microphone</button><button id="cam" disabled>Enable camera</button><button id="leave" disabled>Leave</button>
<div id="status">Ready to join. Enable your camera and microphone after joining.</div><div id="media"></div>
<script>
const $=id=>document.getElementById(id);let room;
const status=text=>$('status').textContent=text;
function explain(error){const messages={NotAllowedError:'Camera or microphone permission was denied. Allow access in the browser site settings, then try again.',NotFoundError:'No camera or microphone was found. Connect a device and try again.',NotReadableError:'The device could not be opened. Close other apps using it and try again.'};return messages[error.name]||error.message;}
if(!window.LivekitClient)status('The meeting software failed to load. Refresh this page to retry.');
function attach(track,local=false){const el=track.attach();el.autoplay=true;el.playsInline=true;if(local)el.muted=true;$('media').appendChild(el);}
function reset(){ $('join').disabled=false;for(const id of ['mic','cam','leave'])$(id).disabled=true;$('media').replaceChildren();$('mic').textContent='Enable microphone';$('cam').textContent='Enable camera'; }
$('join').onclick=async()=>{ $('join').disabled=true;try{
status('Joining meeting...');if(!window.LivekitClient)throw Error('Meeting software did not load. Refresh the page.');
const response=await fetch('/ticket',{method:'POST',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Could not obtain meeting access (HTTP '+response.status+'). Open http://localhost:5174 and retry.');const ticket=await response.json();
room=new LivekitClient.Room();room.on(LivekitClient.RoomEvent.TrackSubscribed,t=>attach(t));
room.on(LivekitClient.RoomEvent.TrackUnsubscribed,t=>t.detach().forEach(e=>e.remove()));
room.on(LivekitClient.RoomEvent.LocalTrackPublished,p=>{if(p.track.kind==='video')attach(p.track,true)});
room.on(LivekitClient.RoomEvent.LocalTrackUnpublished,p=>p.track?.detach().forEach(e=>e.remove()));
room.on(LivekitClient.RoomEvent.Disconnected,()=>{reset();status('Disconnected')});
await room.connect(ticket.url,ticket.token);for(const id of ['mic','cam','leave'])$(id).disabled=false;status('Connected. You can now enable your microphone and camera.');
}catch(e){try{await room?.disconnect()}finally{reset();status('Join failed: '+explain(e))}}};
$('mic').onclick=async()=>{try{status('Updating microphone — allow access if prompted.');await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);$('mic').textContent=room.localParticipant.isMicrophoneEnabled?'Mute microphone':'Enable microphone';status(room.localParticipant.isMicrophoneEnabled?'Microphone is on.':'Microphone is muted.')}catch(e){status(explain(e))}};
$('cam').onclick=async()=>{try{status('Updating camera — allow access if prompted.');await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);$('cam').textContent=room.localParticipant.isCameraEnabled?'Disable camera':'Enable camera';status(room.localParticipant.isCameraEnabled?'Camera is on.':'Camera is off.')}catch(e){status(explain(e))}};
$('leave').onclick=()=>room.disconnect();
</script></body></html>`;

(async () => {
  const room = await api.createRoom({ name: roomName, emptyTimeout: 3600, departureTimeout: 300, maxParticipants: 2 });
  http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/livekit-client.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      fs.createReadStream(path.join(__dirname, 'livekit-client.umd.min.js')).pipe(res);
      return;
    }
    if (req.url === '/ticket' && req.method === 'POST') {
      if (req.headers.origin && !['http://localhost:5174', 'http://127.0.0.1:5174'].includes(req.headers.origin)) { res.writeHead(403); return res.end(); }
      try {
        const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: `guest-${randomUUID()}`, ttl: 3600 });
        token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url, token: await token.toJwt() }));
      } catch { res.writeHead(500); res.end('Meeting access failed'); }
      return;
    }
    if (req.url !== '/') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });res.end(page);
  }).listen(5174, '127.0.0.1', () => console.log(JSON.stringify({ meeting: roomName, sid: room.sid, join: 'http://localhost:5174' })));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
