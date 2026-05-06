const bcrypt = require("bcryptjs");
const { User } = require("../models");

const TEAM = [
  {
    email: "rick@4reel.nl",
    password: "rick4reel",
    name: "Rick",
    teamRole: "Account Manager",
    teamAccessLevel: "admin",
    initials: "R",
    color: "#C8953A",
  },
  {
    email: "ray@4reel.nl",
    password: "ray4reel",
    name: "Ray",
    teamRole: "Strategy",
    teamAccessLevel: "admin",
    initials: "Ra",
    color: "#3A6EA8",
  },
  {
    email: "paolo@4reel.nl",
    password: "paolo4reel",
    name: "Paolo",
    teamRole: "Creative Director",
    teamAccessLevel: "admin",
    initials: "P",
    color: "#C4522A",
  },
  {
    email: "lex@4reel.nl",
    password: "lex4reel",
    name: "Lex",
    teamRole: "Editor",
    teamAccessLevel: "editor",
    initials: "L",
    color: "#7A9E7E",
  },
  {
    email: "boy@4reel.nl",
    password: "boy4reel",
    name: "Boy",
    teamRole: "Owner",
    teamAccessLevel: "admin",
    initials: "B",
    color: "#1C1410",
  },
];

async function seedTeamUsers() {
  let createdCount = 0;
  let updatedCount = 0;

  for (const user of TEAM) {
    const exists = await User.findOne({ email: user.email });
    const hashedPassword = await bcrypt.hash(user.password, 10);
    const nextData = {
      email: user.email,
      passwordHash: hashedPassword,
      role: "team",
      name: user.name,
      teamRole: user.teamRole,
      teamAccessLevel: user.teamAccessLevel,
      initials: user.initials,
      color: user.color,
      clientId: undefined,
    };

    if (!exists) {
      await User.create(nextData);
      createdCount += 1;
      continue;
    }

    exists.set(nextData);
    await exists.save();
    updatedCount += 1;
  }

  return { createdCount, updatedCount, total: TEAM.length };
}

module.exports = { seedTeamUsers };
