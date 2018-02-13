'use strict';

const TwitterOAuth = require('./lib/TwitterOAuth');

const vo        = require('vo');
const uniqid    = require('uniqid');
const Cookie    = require('cookie');
const aws       = require('aws-sdk');
const dynamodb  = new aws.DynamoDB();

module.exports.auth = (event, context, callback) => {
  return vo(function*(){
    const uid   = uniqid();
    const oauth = yield TwitterOAuth.createInstance(event);
    const auth  = yield oauth.getOAuthRequestToken();

    const ret = yield dynamodb.putItem({
      TableName: "twitter_oauth", 
      Item: {
        uid: {S:uid},
        ttl: {N:(new Date().getTime() / 1000 + 60 * 24) + ""},
        session: {S:auth.oauth_token_secret},
      },
    }).promise();

    return callback(null, {
      statusCode: 200,
      body:       'https://twitter.com/oauth/authenticate?oauth_token=' + auth.oauth_token,
      headers:    { 'Set-Cookie': 'sessid=' + uid },
    });

  }).catch(err => {
    console.log("Error on auth:", err);
    return callback(null, { statusCode: 500, body: "ERROR!" });
  });
};

module.exports.callback = (event, context, callback) => {
  vo(function*(){
    const query  = event.queryStringParameters;
    const sessid = Cookie.parse(event.headers.Cookie || '').sessid;
    const oauth  = yield TwitterOAuth.createInstance(event);
    const row    = yield dynamodb.getItem({ TableName: "twitter_oauth", Key: { "uid": {S:sessid} } }).promise();
    
    if (!row.Item) {
      throw new Error("Record not found for sessid=" + sessid);
    }
    
    const oauth_token_secret = row.Item.session.S;
    const ret = yield oauth.getOAuthAccessToken(query.oauth_token, oauth_token_secret, query.oauth_verifier);
    const me  = yield oauth.call_get_api(ret.access_token, ret.access_token_secret, "account/verify_credentials", {});

    yield dynamodb.putItem({
      TableName: "twitter_oauth",
      Item: {
        uid:               {S:sessid},
        twitter_id:        {S:me.id_str},
        screen_name:       {S:me.screen_name},
        display_name:      {S:me.name},
        profile_image_url: {S:me.profile_image_url_https},
        ttl:          {N:(new Date().getTime() / 1000 + 60 * 24 * 30) + ""},
      },
    }).promise();
    
    callback(null, { statusCode: 200, body: "OK" });

  }).catch(err => {
    console.log("Error on callback:", err);
    callback(null, { statusCode: 500, body: "ERROR!" });
  });
};

module.exports.me = (event, context, callback) => {
  return vo(function*(){
    const sessid = Cookie.parse(event.headers.Cookie || '').sessid;

    const ret = yield dynamodb.getItem({
      TableName: "twitter_oauth",
      Key: { "uid": {S:sessid} },
      AttributesToGet: ['twitter_id', 'screen_name', 'display_name', 'profile_image_url']
    }).promise();
    
    const row = ret.Item;
    
    if (!row) {
      throw new Error("LOGIN_EXPIRED=" + sessid);
    }

    if (!row.twitter_id) {
      throw new Error("NOT_LOGGED_IN=" + sessid);
    }
    
    // flatten dynamodb returns
    for (const key of Object.keys(row)) {
      row[key] = row[key].S;
    }

    return callback(null, {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': process.env.TWITTER_OAUTH_ORIGIN_URL,
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify(row),
    });

  }).catch(err => {
    const res = err.message.split("=");
    return callback(null, { statusCode: 500, body: JSON.stringify({ error: res[0] }) });
  });
};
