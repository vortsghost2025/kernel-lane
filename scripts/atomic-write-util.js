module.exports = {
  atomicWriteWithLease: async (filePath, content, laneId, timeoutMs) => {
    // Simple atomic write: write to temp then rename
    const fs = require("fs");
    const path = require("path");
    const tmpPath = filePath + ".tmp";
    await new Promise((resolve, reject) => {
      fs.writeFile(tmpPath, content, { encoding: "utf8" }, err => {
        if (err) reject(err); else resolve();
      });
    });
    fs.renameSync(tmpPath, filePath);
    return { written: true, laneId, timeoutMs };
  }
};
