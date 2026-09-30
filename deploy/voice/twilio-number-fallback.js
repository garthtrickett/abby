// Deploy as a public Twilio Function outside Abby's host. The number's Voice
// Fallback URL points here, so it still works if Abby or its proxy is down.
exports.handler = (context, _event, callback) => {
  const destination = context.ABBY_FALLBACK_NUMBER;
  if (typeof destination !== "string" || !/^\+[1-9]\d{1,14}$/.test(destination)) {
    return callback(new Error("fallback destination unavailable"));
  }
  const response = new Twilio.twiml.VoiceResponse();
  response.dial(destination);
  return callback(null, response);
};
