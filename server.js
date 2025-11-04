// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const ical = require('node-ical');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('db.json');
const db = low(adapter);

// defaults
db.defaults({ users: [], tasks: [], events: [], plans: [], sessions: [] }).write();

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// simple session substitute (demo only): pass userId in query ?user=...
function getUser(req){
  const user = req.query.user || req.body.userId || req.headers['x-user'];
  if(!user) return null;
  return db.get('users').find({ id: user }).value();
}

// Home
app.get('/', (req, res) => {
  res.render('index', { users: db.get('users').value() });
});

// Register (demo)
app.post('/register', (req,res)=>{
  const { name, email } = req.body;
  const id = uuidv4();
  db.get('users').push({ id, name, email, preferences: {}, createdAt: Date.now() }).write();
  return res.redirect(`/?user=${id}`);
});

// Dashboard
app.get('/dashboard', (req,res)=>{
  const user = getUser(req);
  if(!user) return res.redirect('/');
  const tasks = db.get('tasks').filter({ userId: user.id }).value();
  const events = db.get('events').filter({ userId: user.id }).value();
  const plans = db.get('plans').filter({ userId: user.id }).value();
  const sessions = db.get('sessions').filter({ userId: user.id }).value();
  res.render('dashboard', { user, tasks, events, plans, sessions });
});

// Add task
app.post('/task', (req,res)=>{
  const user = getUser(req); if(!user) return res.status(400).send('no user');
  const { title, subject, estMinutes, deadline } = req.body;
  db.get('tasks').push({
    id: uuidv4(), userId: user.id,
    title, subject, estMinutes: parseInt(estMinutes||0), deadline: new Date(deadline).toISOString(),
    createdAt: Date.now()
  }).write();
  return res.redirect(`/dashboard?user=${user.id}`);
});

// Upload .ics
app.post('/import-ics', upload.single('icsfile'), async (req,res)=>{
  const user = getUser(req); if(!user) return res.status(400).send('no user');
  if(!req.file) return res.status(400).send('no file');
  try{
    const data = await ical.parseFile(req.file.path);
    Object.values(data).forEach(ev => {
      if(ev.type === 'VEVENT'){
        db.get('events').push({
          id: uuidv4(),
          userId: user.id,
          title: ev.summary || 'event',
          start: new Date(ev.start).toISOString(),
          end: new Date(ev.end).toISOString(),
          raw: { uid: ev.uid }
        }).write();
      }
    });
  }catch(e){
    console.error(e);
  }
  return res.redirect(`/dashboard?user=${user.id}`);
});

// Simple greedy planner: split tasks into 50-min blocks into available gaps before deadline
const findAvailableSlots = (userId, horizonDays=7) => {
  const events = db.get('events').filter({ userId }).value()
    .map(e => ({ start: new Date(e.start), end: new Date(e.end) }))
    .sort((a,b)=>a.start-b.start);
  // Build busy windows array and return function to check free windows (very simplified)
  return function findSlotsBetween(startDate, endDate){
    // produce array of free slots between startDate and endDate excluding events
    const slots = [];
    let cursor = new Date(startDate);
    for(const ev of events){
      if(ev.end <= cursor) continue;
      if(ev.start > cursor){
        slots.push({ start: new Date(cursor), end: new Date(ev.start) });
      }
      cursor = new Date(Math.max(cursor, ev.end));
      if(cursor >= endDate) break;
    }
    if(cursor < endDate) slots.push({ start: new Date(cursor), end: new Date(endDate) });
    return slots;
  };
};

app.post('/generate-plan', (req,res)=>{
  const user = getUser(req); if(!user) return res.status(400).send('no user');
  const horizonDays = parseInt(req.body.horizon||7);
  const tasks = db.get('tasks').filter({ userId: user.id }).value()
    .sort((a,b)=> new Date(a.deadline) - new Date(b.deadline));
  const findSlots = findAvailableSlots(user.id, horizonDays);
  const now = new Date();
  const horizon = new Date(); horizon.setDate(now.getDate()+horizonDays);
  // simple scheduler: for each task put 50-min blocks until estMinutes filled
  const plan = [];
  tasks.forEach(task=>{
    let remaining = task.estMinutes;
    const deadline = new Date(task.deadline) < horizon ? new Date(task.deadline) : horizon;
    const freeSlots = findSlots(now, deadline);
    for(const slot of freeSlots){
      if(remaining<=0) break;
      // break slot into 50-min blocks
      let cursor = new Date(slot.start);
      while(cursor < slot.end && remaining>0){
        const blockEnd = new Date(cursor.getTime() + 50*60000);
        if(blockEnd > slot.end) break;
        plan.push({
          id: uuidv4(),
          userId: user.id,
          taskId: task.id,
          title: task.title,
          subject: task.subject,
          start: cursor.toISOString(),
          end: blockEnd.toISOString()
        });
        cursor = new Date(blockEnd.getTime() + 10*60000); // 10-min break after block
        remaining -= 50;
      }
    }
  });
  // save plan object
  const planRec = { id: uuidv4(), userId: user.id, createdAt: Date.now(), horizonDays, blocks: plan };
  db.get('plans').push(planRec).write();
  return res.redirect(`/dashboard?user=${user.id}`);
});

// Start session (mark session started)
app.post('/session/start', (req,res)=>{
  const user = getUser(req); if(!user) return res.status(400).send('no user');
  const { blockId } = req.body;
  const block = db.get('plans').map('blocks').flatten().find({ id: blockId, userId: user.id }).value();
  if(!block) return res.status(404).send('block not found');
  const sess = { id: uuidv4(), userId: user.id, blockId, start: new Date().toISOString(), end: null, status: 'inprogress' };
  db.get('sessions').push(sess).write();
  return res.redirect(`/dashboard?user=${user.id}`);
});

// End session
app.post('/session/end', (req,res)=>{
  const user = getUser(req); if(!user) return res.status(400).send('no user');
  const { sessionId, focusScore } = req.body;
  const sess = db.get('sessions').find({ id: sessionId, userId: user.id }).value();
  if(!sess) return res.status(404).send('session not found');
  db.get('sessions').find({ id: sessionId }).assign({ end: new Date().toISOString(), status: 'completed', focusScore: focusScore||null }).write();
  return res.redirect(`/dashboard?user=${user.id}`);
});

// Simple analytics
app.get('/analytics', (req,res)=>{
  const user = getUser(req); if(!user) return res.status(400).send('no user');
  const plans = db.get('plans').filter({ userId: user.id }).value();
  const sessions = db.get('sessions').filter({ userId: user.id }).value();
  // compute adherence %
  const plannedBlocks = plans.reduce((acc,p)=>acc + (p.blocks? p.blocks.length:0),0);
  const completed = sessions.filter(s=>s.status==='completed').length;
  const adherence = plannedBlocks ? Math.round(completed/plannedBlocks*100) : 0;
  res.render('analytics', { user, plannedBlocks, completed, adherence });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server running on http://localhost:'+PORT));