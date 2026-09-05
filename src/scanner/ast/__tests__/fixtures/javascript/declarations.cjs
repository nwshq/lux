function factory() { return new Legacy(); }
class Legacy { build() { return factory(); } }
const assigned = function () {};
module.exports = factory;
exports.Legacy = Legacy;
