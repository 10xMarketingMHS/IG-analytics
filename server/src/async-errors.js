import Layer from "express/lib/router/layer.js";

// Express 4 catches an error a route throws, but not one from an async route:
// a rejected promise (a database timeout before a route's own try, say) went
// unhandled, and Node stops the whole server on that. Every route handler's
// promise is followed here, so its error reaches the error handler (a 500 for
// that one request) like a thrown one does. Imported once, first, by index.js.
Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // an error handler: not for a plain request
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === "function") out.then(null, (err) => next(err ?? new Error("Request failed")));
  } catch (err) {
    next(err);
  }
};

// Anything else left unhandled (background work outside a request) is logged,
// not a reason to drop every signed-in user.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});
