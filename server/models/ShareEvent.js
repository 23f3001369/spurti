import mongoose from 'mongoose';

// One row per time a student shares or downloads an achievement card. This is
// the point of the whole feature — knowing whether students actually post them,
// and which achievements are worth posting.
const shareEventSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  email: { type: String, default: '' },
  name: { type: String, default: '' },
  achId: { type: String, required: true },
  title: { type: String, default: '' },
  platform: { type: String, enum: ['linkedin', 'whatsapp', 'download', 'copy', 'native'], required: true },
  at: { type: Date, default: Date.now, index: true }
});

export default mongoose.model('ShareEvent', shareEventSchema);
