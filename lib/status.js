// The shared status vocabulary: every leg (hub, local) and the flower
// view colors with these four statuses and ranks worst-wins with this
// one order. Single source — a drifting copy would silently break the
// overall verdict.

const STATUS = {
  GRAY: "gray",
  GREEN: "green",
  YELLOW: "yellow",
  RED: "red",
};

const STATUS_RANK = { gray: 0, green: 1, yellow: 2, red: 3 };

module.exports = {
  STATUS,
  STATUS_RANK,
};
