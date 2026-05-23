#!/usr/bin/env node

const message = [
  "",
  "================================================",
  "Repository migration notice",
  "================================================",
  "",
  "This repository has been split into separate projects.",
  "Delete this installation and clone the correct repository.",
  "",
  "Old Microsoft Rewards dashboard:",
  "https://github.com/QuestPilot/Microsoft-Rewards-Bot-Classic",
  "New Microsoft Rewards dashboard:",
  "https://github.com/QuestPilot/Microsoft-Rewards-Bot/tree/main",
  "",
  "This copy no longer contains the bot.",
  "",
].join("\n");

console.log(message);
