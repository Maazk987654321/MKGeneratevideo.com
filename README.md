# MK Video Generate

## Zaroori baat
GitHub Pages sirf static files (HTML/CSS) chalata hai. Isme server.js, database aur login nahi chal sakte,
isi wajah se aapki site par code text ki tarah dikh raha tha aur buttons kaam nahi kar rahe the.
Is project ko Node.js server wali hosting par chalana hoga (jaise Render.com).

## Render.com par chalane ke steps
1. Is poore folder ko ek GitHub repository me upload karein (.env upload NA karein).
2. render.com par New > Web Service > apni repository chunein.
3. Build Command: `npm install`   |   Start Command: `npm start`
4. Environment me ye values daalein: FAL_KEY, JWT_SECRET, OWNER_EMAIL, OWNER_PASSWORD, NODE_ENV=production
5. Database permanent rakhne ke liye Render me ek Disk jodein (mount path /data) aur DB_PATH=/data/data.db set karein.
6. Deploy karein. Apne OWNER_EMAIL aur OWNER_PASSWORD se login karenge to aapko unlimited use milega.

## Local par chalane ke liye
npm install, .env.example ko .env me copy karke values bharein, phir `npm start` aur http://localhost:3000 kholein.
