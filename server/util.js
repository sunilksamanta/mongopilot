function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

module.exports = { asyncHandler, NAME_RE };
