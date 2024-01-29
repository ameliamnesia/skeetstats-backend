import bsky from '@atproto/api';
const { BskyAgent } = bsky;
import * as dotenv from 'dotenv';
dotenv.config();
import { agent } from './server.js';
import { backend_did } from './server.js';
import { checkSession } from './server.js';
import { checkStatus, insertDataIntoTable, removeDataFromTable, unknownCommand } from './respond.js';
import { connection } from './server.js';
import { writeLog } from './util.js';
export async function processPost(post) {
    try {
        if (post.text === "!optin") {
            let profile = await fetchProfile(post.author);
            await insertDataIntoTable(post.author, post.cid, post.uri, profile.name, profile.handle, async (error) => {
                if (error) {
                    console.error('Error in opt-in command:', error);
                    writeLog('cmd_error.log', (`error handling opt in command: ${error}`));
                }
            });
        }
        else if (post.text === "!optout") {
            let profile = await fetchProfile(post.author);
            await removeDataFromTable(post.author, post.cid, post.uri, profile.name, profile.handle, async (error) => {
                if (error) {
                    console.error('Error in opt out command:', error);
                    writeLog('cmd_error.log', (`error handling opt out command: ${error}`));
                }
            });
        }
        else if (post.text === "!status") {
            let profile = await fetchProfile(post.author);
            await checkStatus(post.author, post.cid, post.uri, profile.name, profile.handle, async (error) => {
                if (error) {
                    console.error('Error checking status:', error);
                    writeLog('cmd_error.log', (`error handling status command: ${error}`));
                }
            });
        }
        else {
            let profile = await fetchProfile(post.author);
            await unknownCommand(post.author, post.cid, post.uri, profile.name, profile.handle, async (error) => {
                if (error) {
                    console.error('Error handling unknown command:', error);
                    writeLog('cmd_error.log', (`error handling unknown command: ${error}`));
                }
            });
        }
    }
    catch (error) {
        console.error('Error processing post:', error.message);
        writeLog('cmd_error.log', (`error processing post: ${error.message}`));
    }
}
export async function fetchProfile(author) {
    await checkSession(backend_did);
    let profile = await agent.getProfile({ actor: author });
    let profilename = profile.data.displayName ?? profile.data.handle;
    let profilehandle = profile.data.handle;
    const data = {
        name: profilename,
        handle: profilehandle
    };
    return data;
}
export async function updateIsReadStatus(cid) {
    const updateQuery = 'UPDATE post SET isRead = 1 WHERE cid = ?';
    connection.query(updateQuery, [cid], (error) => {
        if (error) {
            console.error('Error updating isRead status:', error.message);
            writeLog('error.log', (`error updating read status: ${error.message}`));
        }
    });
}
export async function deleteReadPosts() {
    // Construct the SQL query to delete rows
    const deleteQuery = `DELETE FROM post WHERE isRead = 1`;
    connection.query(deleteQuery, (error) => {
        if (error) {
            console.error('Error deleting read posts:', error.message);
            writeLog('error.log', (`error deleting read posts: ${error.message}`));
        }
    });
}
export async function selectUnreadPosts() {
    const sqlQuery = 'SELECT cid, uri, author, text FROM post WHERE isRead = 0';
    connection.query(sqlQuery, async (error, results) => {
        if (error) {
            console.error('error selecting unread:', error.message);
            writeLog('error.log', (`error selecting unread: ${error.message}`));
        }
        else {
            for (const post of results) {
                await processPost(post);
            }
        }
    });
}
export async function userBrag() {
    let opted;
    const countQuery = `SELECT COUNT(*) AS userCount FROM opted_in`;
    connection.query(countQuery, async (error, results) => {
        if (error) {
            console.log('error counting users:', error.message);
            writeLog('error.log', (`error counting users: ${error.message}`));
        }
        let uc = { ...results[0] };
        opted = String(uc.userCount);
        await checkSession(backend_did);
        await agent.app.bsky.feed.post.create({
            repo: backend_did,
        }, {
            text: `${opted} users have opted in to skeetstats so far! if you want to be in the next update tag me with the command !optin`,
            lang: 'en',
            embed: {
                $type: 'app.bsky.embed.external',
                external: {
                    uri: 'https://skeetstats.xyz',
                    /*
                    thumb: {
                      '$type': 'blob',
                      ref: {
                        '$link': 'bafkreicn3ad2npcbj5f3ssg4tyr4m5kq3fgps3gjqqbdm664wcdrcy3ele'
                      },
                      mimeType: 'image/jpeg',
                      size: 848574
                    },*/
                    title: 'SkeetStatsfor bluesky',
                    description: 'track your posting stats!',
                },
            },
            createdAt: new Date().toISOString()
        });
    });
}
