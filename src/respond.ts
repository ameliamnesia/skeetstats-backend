import { backend_did } from './server.js';
import { agent } from './server.js';
import { checkSession } from './server.js';
import { get, request } from 'node:https';
import { connection } from './server.js';
import { updateIsReadStatus } from './optin.js';
import { writeLog } from './util.js';

export async function checkStatus(did, cid, uri, name, handle, callback?) {
  const sql = 'SELECT * FROM opted_in WHERE dids = ?';
  let noUserExists = `, you're not currently opted in. tag me again with the command !optin to be in the next update`
  let userExists = `, you're opted in!`

  connection.query(sql, [did]);
  connection.query(sql, [did], async (error, results) => {
    if (error) {
      console.error('Error checking status from the database:', error);
      writeLog('respond_error.log', (`Error checking status: ${error}`))
      return callback(error);
    }
    if (results.length > 0) {
      //console.log(`Data removed successfully for did: ${did}`);
      await reply(did, cid, uri, name, handle, userExists)
    } else {
      //console.log(`Data with did ${did} not found.`);
      await reply(did, cid, uri, name, handle, noUserExists)
    }
    callback(null, results);
  });
}
export async function insertDataIntoTable(did, cid, uri, name, handle, callback?) {
  let userExists = `, you're already opted in`
  let userOptedIn = `, you've opted in!`
  const sql = 'INSERT INTO opted_in (dids) VALUES (?)';
  connection.query(sql, [did], async (error, results) => {
    if (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        console.log(`User with did ${did} already exists.`);
        await reply(did, cid, uri, name, handle, userExists)
        return callback(null); // treat as success
      }
      console.error('Error inserting data into the database:', error);
      writeLog('respond_error.log', (`Error opting in: ${error}`))
      return callback(error);
    }
    console.log(`Data inserted successfully for did: ${did}`);
    await reply(did, cid, uri, name, handle, userOptedIn)
    callback(null, results);
  });
}
export async function removeDataFromTable(did, cid, uri, name, handle, callback?) {
  let noUserExists = `, you're not currently opted in`
  let userOptedOut = `, you've been opted out!`
  const sql = 'DELETE FROM opted_in WHERE dids = ?';
  connection.query(sql, [did], async (error, results) => {
    if (error) {
      console.error('Error removing data from the database:', error);
      writeLog('respond_error.log', (`Error opting out: ${error}`))
      return callback(error);
    }

    if (results.affectedRows > 0) {
      console.log(`Data removed successfully for did: ${did}`);
      await reply(did, cid, uri, name, handle, userOptedOut)
    } else {
      console.log(`Data with did ${did} not found.`);
      await reply(did, cid, uri, name, handle, noUserExists)
    }

    callback(null, results);
  });
}
export async function unknownCommand(did, cid, uri, name, handle, callback?) {
  let weirdCommand = `, sorry i'm not familiar with that command. if it is a valid command please tag @/ameliamnesia.xyz`
  await reply(did, cid, uri, name, handle, weirdCommand)
  callback(null);
}
export async function getMeta(url: string): Promise<{ title: string | null, description: string | null }> {
  const options = {
    method: 'GET',
  };

  return new Promise((resolve) => {
    const req = request(url, options, (response) => {
      let html = '';

      response.on('data', (chunk) => {
        html += chunk;
      });

      response.on('end', () => {
        const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        const ogTitle = ogTitleMatch ? ogTitleMatch[1] : null;

        const ogDescriptionMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
        const ogDescription = ogDescriptionMatch ? ogDescriptionMatch[1] : null;

        resolve({
          title: ogTitle,
          description: ogDescription,
        });
      });
    });

    req.on('error', (error) => {
      console.error('Error:', error.message);
      resolve({
        title: null,
        description: null,
      });
    });

    req.end();
  });
}

export async function reply(authordid: string, cid: string, uri: string, name: string, handle: string, replytext: string) {
  await checkSession(backend_did)
  const websiteUrl = 'https://skeetstats.xyz';
  const { title, description } = await getMeta(websiteUrl);
  let trunchandle = name.slice(0, 200)
  let shortname = name.slice(0, 30)
  let urlhandle = handle ?? authordid
  await agent.app.bsky.feed.post.create({
    repo: backend_did,
  }, {
    reply: {
      parent: {
        cid: cid,
        uri: uri,
      },
      root: {
        cid: cid,
        uri: uri,
      },
    },
    text: trunchandle + replytext,
    lang: 'en',
    embed: {
      $type: 'app.bsky.embed.external',
      external: {
        uri: `${websiteUrl}/user/${urlhandle}`,
        title: `${title} - ${shortname}` || 'SkeetStats',
        description: description || 'track your posting stats!',
      },
    },
    createdAt: new Date().toISOString(),
  })
  await agent.like(uri, cid)
  await updateIsReadStatus(cid);
}