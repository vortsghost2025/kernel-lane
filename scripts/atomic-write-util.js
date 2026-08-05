module.exports = {
  atomicWriteWithLease: async (filePath, content, laneId, timeoutMs) => {
    const fs = require("fs");
    const path = require("path");
    const tmpPath = filePath + ".tmp";
    const data = (typeof content === "object" && content !== null)
      ? JSON.stringify(content, null, 2)
      : String(content);
    await new Promise((resolve, reject) => {
      fs.writeFile(tmpPath, data, { encoding: "utf8" }, err => {
        if (err) reject(err); else resolve();
      });
    });
    fs.renameSync(tmpPath, filePath);
    return { written: true, laneId, timeoutMs };
  }
};
