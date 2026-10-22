import { sql } from '../db.ts';

export async function purgeExpiredEdgeFeedback() {
  await sql`DELETE FROM edge_feedback_limits WHERE expires_at<now()`;
  return (await sql`DELETE FROM feedback WHERE edge_submission AND created_at<now()-interval '30 days' RETURNING id`).length;
}
