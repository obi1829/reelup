'use strict';

// Build destination path: basePath/YYYY/YYYY-MM-DD/filename
// Shared by the SFTP and Nextcloud backends.
function buildRemotePath(basePath, file) {
  const date = new Date(file.mtime);
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  return `${basePath}/${year}/${dateStr}/${file.name}`;
}

module.exports = { buildRemotePath };
