const crypto = require("crypto");

function parseFrameOutcome(payload = {}) {
  const eventType = String(
    payload.event || payload.type || payload.action || "",
  ).toLowerCase();
  const status = String(
    payload.status || payload.reviewStatus || payload.approval || "",
  ).toLowerCase();
  const decision = String(
    payload.decision || payload.result || payload.outcome || "",
  ).toLowerCase();
  const merged = `${eventType} ${status} ${decision}`;
  if (/(approve|approved|accept)/.test(merged)) return "approved";
  if (/(revision|revise|changes_requested|changes-requested|request_changes|requested_changes|reject|rejected)/.test(merged)) {
    return "revision";
  }
  return "";
}

function getFrameAssetIdFromPayload(payload = {}) {
  const candidates = [
    payload?.resource?.id,
    payload?.resource?.asset_id,
    payload?.resource?.assetId,
    payload?.asset?.id,
    payload?.asset?.asset_id,
    payload?.assetId,
    payload?.asset_id,
    payload?.data?.asset?.id,
    payload?.data?.asset_id,
    payload?.data?.assetId,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function getFrameEventIdFromPayload(payload = {}) {
  const candidates = [
    payload.id,
    payload.event_id,
    payload.eventId,
    payload.delivery_id,
    payload.deliveryId,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function getFrameRevisionNote(payload = {}) {
  const candidates = [
    payload?.comment?.text,
    payload?.comment,
    payload?.message,
    payload?.note,
    payload?.reason,
    payload?.data?.comment?.text,
    payload?.data?.comment,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim().slice(0, 1000);
  }
  return "Revision requested via Frame.io";
}

function verifyFrameWebhookSignature({ secret, rawBody, body, signature }) {
  if (!secret || !signature) return false;
  const payloadText =
    typeof rawBody === "string" && rawBody.length
      ? rawBody
      : JSON.stringify(body || {});
  const digest = crypto
    .createHmac("sha256", String(secret))
    .update(payloadText)
    .digest("hex");
  const computed = `sha256=${digest}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
  } catch {
    return false;
  }
}

module.exports = {
  parseFrameOutcome,
  getFrameAssetIdFromPayload,
  getFrameEventIdFromPayload,
  getFrameRevisionNote,
  verifyFrameWebhookSignature,
};
