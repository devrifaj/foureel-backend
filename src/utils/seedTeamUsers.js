const bcrypt = require("bcryptjs");
const { User } = require("../models");

const TEAM = [
  {
    email: "rick@4reel.nl",
    password: "rick4reel",
    name: "Rick",
    teamRole: "Account Manager",
    initials: "R",
    color: "#C8953A",
  },
  {
    email: "ray@4reel.nl",
    password: "ray4reel",
    name: "Ray",
    teamRole: "Strategy",
    initials: "Ra",
    color: "#3A6EA8",
  },
  {
    email: "paolo@4reel.nl",
    password: "paolo4reel",
    name: "Paolo",
    teamRole: "Creative Director",
    initials: "P",
    color: "#C4522A",
  },
  {
    email: "lex@4reel.nl",
    password: "lex4reel",
    name: "Lex",
    teamRole: "Editor",
    initials: "L",
    color: "#7A9E7E",
  },
  {
    email: "boy@4reel.nl",
    password: "boy4reel",
    name: "Boy",
    teamRole: "Owner",
    initials: "B",
    color: "#1C1410",
  },
];

async function seedTeamUsers() {
  let createdCount = 0;

  for (const user of TEAM) {
    const exists = await User.findOne({ email: user.email });
    if (exists) continue;

    await User.create({
      ...user,
      passwordHash: await bcrypt.hash(user.password, 10),
      role: "team",
    });
    createdCount += 1;
  }

  return { createdCount, total: TEAM.length };
}

module.exports = { seedTeamUsers };
