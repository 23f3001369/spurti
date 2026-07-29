import mongoose from 'mongoose';
import { MONGO_URI } from '../config.js';
import PeerReviewSubmission from '../models/PeerReviewSubmission.js';

function computeTeamLink(prLink) {
  const raw = prLink.trim().toLowerCase();
  if (/\/pull[s]?\/(\d+)/.test(raw)) {
    return 'pr-' + raw.match(/\/pull[s]?\/(\d+)/)[1];
  } else if (/^\d+$/.test(raw)) {
    return 'pr-' + raw;
  } else if (/team-/.test(raw)) {
    const parts = raw.replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '').replace(/[?#].*$/, '').split('/');
    return parts[parts.length - 1];
  } else if (/^[0-9a-f]{10,}$/.test(raw)) {
    return 'team-' + raw;
  } else {
    return raw.replace(/\/+$/, '').replace(/[?#].*$/, '');
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const all = await PeerReviewSubmission.find({ teamLink: null }).lean();
  console.log(`Found ${all.length} submissions without teamLink`);

  let updated = 0;
  for (const sub of all) {
    const teamLink = computeTeamLink(sub.prLink);
    await PeerReviewSubmission.updateOne({ _id: sub._id }, { $set: { teamLink } });
    updated++;
  }

  console.log(`Backfilled ${updated} submissions`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
