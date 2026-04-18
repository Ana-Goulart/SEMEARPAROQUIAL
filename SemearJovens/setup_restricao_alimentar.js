const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'database.sqlite');
const sqlite3 = require('sqlite3').verbose();

const startSetup = () => {
    if (!fs.existsSync(dbPath)) {
        console.error("Database file missing.");
        return;
    }

    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error("Error opening database:", err.message);
            return;
        }
        console.log("Connected to the SQLite database.");

        db.serialize(() => {
            db.run(`ALTER TABLE jovens ADD COLUMN restricao_alimentar INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes("duplicate column name")) {
                    console.error("Error adding restricao_alimentar:", err.message);
                } else {
                    console.log("Column 'restricao_alimentar' added or already exists.");
                }
            });

            db.run(`ALTER TABLE jovens ADD COLUMN detalhes_restricao TEXT`, (err) => {
                if (err && !err.message.includes("duplicate column name")) {
                    console.error("Error adding detalhes_restricao:", err.message);
                } else {
                    console.log("Column 'detalhes_restricao' added or already exists.");
                }
            });
        });

        db.close((err) => {
            if (err) {
                console.error("Error closing database:", err.message);
            } else {
                console.log("Database connection closed.");
            }
        });
    });
};

startSetup();
