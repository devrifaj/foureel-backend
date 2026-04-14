const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── User (team + clients) ────────────────────────────────────
const UserSchema = new Schema({
  email:        { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ['team', 'client'], required: true },
  name:         { type: String, required: true },
  initials:     String,
  color:        String,
  teamRole:     String, // 'Creative Director', 'Editor', etc.
  clientId:     { type: Schema.Types.ObjectId, ref: 'Client' }, // for portal users
}, { timestamps: true });

// ── Client ────────────────────────────────────────────────────
const ClientSchema = new Schema({
  name:          { type: String, required: true },
  sector:        String,
  phase:         String,
  contact:       String,
  email:         String,
  phone:         String,
  since:         String,
  urgent:        { type: Boolean, default: false },
  urgentReason:  String,
  color:         { type: String, default: '#C4522A' },
  welcomeMessage: String,
  // Portal
  portalPassword: String, // hashed
  portalEmail:    String,
  // Shoot
  shoot: {
    name:     String,
    date:     String,
    location: String,
    info:     String,
    status:   { type: String, enum: ['planned', 'soon', 'wrapped'], default: 'planned' }
  },
  // Retainer
  retainer: {
    pakket:             String,
    prijs:              String,
    periode:            String,
    betaalmethode:      String,
    startdatum:         String,
    einddatum:          String,
    looptijd:           String,
    shoots:             String,
    videos:             String,
    extras:             String,
    status:             { type: String, enum: ['actief', 'gepauzeerd', 'opgezegd', 'concept'], default: 'concept' },
    notities:           String,
    zichtbaarInPortaal: { type: Boolean, default: false },
  }
}, { timestamps: true });

// ── Event ─────────────────────────────────────────────────────
const EventSchema = new Schema({
  name:     { type: String, required: true },
  type:     { type: String, enum: ['Shoot', 'Edit', 'Deadline', 'Call', 'Delivery'], required: true },
  date:     { type: String, required: true }, // YYYY-MM-DD
  clientId: { type: Schema.Types.ObjectId, ref: 'Client' },
  client:   String, // client name string for display
  notes:    String,
}, { timestamps: true });

// ── Task ──────────────────────────────────────────────────────
const ChecklistItemSchema = new Schema({ text: String, done: { type: Boolean, default: false } });

const TaskSchema = new Schema({
  title:      { type: String, required: true },
  assignee:   String,
  clientId:   { type: Schema.Types.ObjectId, ref: 'Client' },
  client:     String,
  column:     { type: String, enum: ['todo', 'bezig', 'review', 'klaar'], default: 'todo' },
  priority:   { type: String, enum: ['High', 'Normal', 'Low'], default: 'Normal' },
  dueDate:    String,
  description: String,
  checklist:  [ChecklistItemSchema],
  archived:   { type: Boolean, default: false },
  archivedAt: Date,
  archiveReason: String,
}, { timestamps: true });

// ── Video (embedded in Batch) ─────────────────────────────────
const ShotSchema    = new Schema({ text: String, done: { type: Boolean, default: false } });
const SopSchema     = new Schema({
  format: String, muziek: String, kleurprofiel: String, extraNotes: String,
  ratioTags: [String], stijlTags: [String]
});

const VideoSchema = new Schema({
  name:      { type: String, required: true },
  editFase:  { type: String, default: 'tentative' },
  assets:    String, // Frame.io export link
  export:    String, // Drive export link
  notes:     String,
  script:    String,
  driveLink: String, // brand assets
  shotlist:  [ShotSchema],
  sop:       SopSchema,
  // Portal review state
  portalPushed:    { type: Boolean, default: false },
  revision:        { type: Boolean, default: false },
  revisionNote:    String,
  approved:        { type: Boolean, default: false },
  approvedAt:      Date,
}, { timestamps: true });

// ── Batch ─────────────────────────────────────────────────────
const BatchSchema = new Schema({
  name:       { type: String, required: true },
  emoji:      { type: String, default: '🎬' },
  clientId:   { type: Schema.Types.ObjectId, ref: 'Client' },
  client:     String,
  editor:     String,
  shootDate:  String,
  deadline:   String,
  videos:     [VideoSchema],
}, { timestamps: true });

// ── Portal Note (chat message) ────────────────────────────────
const NoteSchema = new Schema({
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
  from:     { type: String, enum: ['studio', 'client'], required: true },
  author:   String,
  text:     { type: String, required: true },
  read:     { type: Boolean, default: false },
}, { timestamps: true });

// ── Questionnaire ─────────────────────────────────────────────
const QuestionnaireSchema = new Schema({
  clientId:    { type: Schema.Types.ObjectId, ref: 'Client', required: true, unique: true },
  answers:     { type: Map, of: Schema.Types.Mixed },
  fileKeys:    [String], // S3 keys for uploaded files
  submitted:   { type: Boolean, default: false },
  submittedAt: Date,
  openedAt:    Date,
}, { timestamps: true });

// ── Activity ──────────────────────────────────────────────────
const ActivitySchema = new Schema({
  text:   String,
  color:  String,
  view:   String,
  user:   String,
}, { timestamps: true });

module.exports = {
  User:          mongoose.model('User', UserSchema),
  Client:        mongoose.model('Client', ClientSchema),
  Event:         mongoose.model('Event', EventSchema),
  Task:          mongoose.model('Task', TaskSchema),
  Batch:         mongoose.model('Batch', BatchSchema),
  Note:          mongoose.model('Note', NoteSchema),
  Questionnaire: mongoose.model('Questionnaire', QuestionnaireSchema),
  Activity:      mongoose.model('Activity', ActivitySchema),
};
