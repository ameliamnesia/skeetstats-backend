import fs from 'fs';
const logTime = new Date().toLocaleString('en-US', { timeZone: 'EST' })
  export function writeLog(file?, content?) {
    let contents = `${logTime} ${content} \n`;
    fs.appendFile(file ?? 'other.log', contents, err => {
        if (err) {
          console.error(err);
        } else {
          console.log('log written')
        }
      });
  }