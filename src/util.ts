import fs from 'fs';
const logTime = logDate();
export function logDate(): string {
    const currentDate = new Date();
  
    // Get the components of the date and time
    const year = currentDate.getFullYear();
    const month = (currentDate.getMonth() + 1).toString().padStart(2, '0');
    const day = currentDate.getDate().toString().padStart(2, '0');
    const hours = currentDate.getHours().toString().padStart(2, '0');
    const minutes = currentDate.getMinutes().toString().padStart(2, '0');
    const seconds = currentDate.getSeconds().toString().padStart(2, '0');
  
    // Format the date and time
    const logDate = `${month}/${day}/${year % 100} ${hours}:${minutes}:${seconds}`;
  
    return logDate;
  }

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