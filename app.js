import express from "express";
import multer from "multer";
import AWS from "aws-sdk";
import dotenv from "dotenv";
// import execa from "execa"; // Use import instead of require
import { exec, spawn } from "child_process"; // Include spawn here
import { execFile } from "child_process";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path"; // Import path module
dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// Configure AWS SDK for DigitalOcean Spaces
const spacesEndpoint = new AWS.Endpoint(
  `https://${process.env.DO_SPACE_REGION}.digitaloceanspaces.com`
);
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.DO_SPACE_KEY,
  secretAccessKey: process.env.DO_SPACE_SECRET,
});

// Middleware for parsing JSON
app.use(express.json());
// Middleware to parse JSON requests
app.use(bodyParser.json());

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Create a folder (essentially a prefix in S3)
app.post("/folders/*", async (req, res) => {
  const folderPath = req.params[0]; // Capture full path after /folders/

  // Create a placeholder file to represent the folder in S3
  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Key: `${folderPath}/`, // Ensure it ends with a '/' to represent a folder
    Body: "", // Empty body
    ACL: "public-read", // Optional: set permissions if necessary
  };

  try {
    await s3.putObject(params).promise(); // Create the folder by putting an empty object
    res.json({ message: `Folder "${folderPath}" created.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create folder." });
  }
});

// Function to list files and folders recursively
async function listAllContents(prefix) {
  let files = [];
  let folders = [];

  let continuationToken;

  do {
    const params = {
      Bucket: process.env.DO_SPACE_NAME,
      Prefix: prefix,
      Delimiter: "/",
      ContinuationToken: continuationToken,
    };

    const data = await s3.listObjectsV2(params).promise();

    // Gather files
    files = files.concat(data.Contents.map((file) => file.Key));

    // Gather folder prefixes
    const currentFolders = data.CommonPrefixes.map((prefix) => prefix.Prefix);
    folders = folders.concat(currentFolders);

    continuationToken = data.IsTruncated ? data.NextContinuationToken : null;
  } while (continuationToken);

  return { files, folders };
}

// Function to gather contents of a folder and its nested folders
async function getFolderContents(folderPath) {
  const { files, folders } = await listAllContents(folderPath);

  // Recursively fetch contents of each subfolder
  for (const folder of folders) {
    const subContents = await getFolderContents(folder);
    files.push(...subContents.files); // Merge files
    folders.push(...subContents.folders); // Merge folders
  }

  return { files, folders };
}

// List files and folders in a specified path
app.get("/folders/*", async (req, res) => {
  const folderPath = req.params[0]; // Capture full path after /folders/

  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Prefix: `${folderPath}/`,
    Delimiter: "/", // Use delimiter to get only the first level of "folders"
  };

  try {
    const data = await s3.listObjectsV2(params).promise();
    const files = data.Contents.map((file) => file.Key);
    const commonPrefixes = data.CommonPrefixes.map((prefix) => prefix.Prefix);

    // Check if the folderPath has any new folders created
    const newFolderKey = `${folderPath}/`;
    if (files.length === 0 && commonPrefixes.length === 0) {
      // Check if there are any folders starting with folderPath
      const paramsCheck = {
        Bucket: process.env.DO_SPACE_NAME,
        Prefix: newFolderKey, // Check for any subfolders under the current path
        Delimiter: "/",
      };
      const checkData = await s3.listObjectsV2(paramsCheck).promise();

      // Dynamically add any found folders
      checkData.CommonPrefixes.forEach((prefix) => {
        commonPrefixes.push(prefix.Prefix);
      });
    }

    res.json({
      files: files.map((file) => ({
        file,
        signedUrl: s3.getSignedUrl("getObject", {
          Bucket: process.env.DO_SPACE_NAME,
          Key: file,
          Expires: 60 * 5, // URL expires in 5 minutes
        }),
      })),
      folders: commonPrefixes,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to retrieve folder contents." });
  }
});

// Upload a file to a specified path
app.post("/files/*", upload.single("file"), async (req, res) => {
  const filePath = req.params[0]; // Capture full path after /files/
  const file = req.file;

  // Check if file is provided
  if (!file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  // Function to determine the content type based on the file extension
  const determineContentType = (filename) => {
    const extension = filename.split(".").pop().toLowerCase();
    switch (extension) {
      case "html":
        return "text/html";
      case "css":
        return "text/css";
      case "js":
        return "application/javascript";
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "gif":
        return "image/gif";
      case "svg":
        return "image/svg+xml";
      case "json":
        return "application/json";
      case "pdf":
        return "application/pdf";
      default:
        return "application/octet-stream"; // Default for unknown file types
    }
  };

  // Determine the content type
  const contentType = determineContentType(file.originalname);

  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Key: `${filePath}/${file.originalname}`, // Full path in the bucket
    Body: file.buffer,
    ACL: "public-read", // Ensure the file is publicly accessible
    ContentType: contentType, // Set the correct content type
  };

  try {
    // Upload the file to DigitalOcean Spaces
    await s3.upload(params).promise();
    res.json({
      message: `File "${file.originalname}" uploaded to "${filePath}".`,
      contentType,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to upload file." });
  }
});

// Serve a file
app.get("/files/*", async (req, res) => {
  const filePath = req.params[0]; // Capture full path after /files/
  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Key: filePath,
  };

  try {
    const url = s3.getSignedUrl("getObject", {
      Bucket: process.env.DO_SPACE_NAME,
      Key: filePath,
      Expires: 60 * 5, // URL expires in 5 minutes
    });
    res.json({ url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to retrieve file." });
  }
});

// Delete a folder (all objects with the prefix)
app.delete("/folders/*", async (req, res) => {
  const folderPath = req.params[0]; // Capture full path after /folders/

  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Prefix: `${folderPath}/`, // Specify the folder prefix
  };

  try {
    // List all objects with the prefix (folder path)
    const data = await s3.listObjectsV2(params).promise();

    if (data.Contents.length === 0) {
      return res
        .status(404)
        .json({ error: "Folder is empty or does not exist." });
    }

    // Prepare objects for deletion
    const deleteParams = {
      Bucket: process.env.DO_SPACE_NAME,
      Delete: {
        Objects: data.Contents.map((item) => ({ Key: item.Key })),
      },
    };

    // Delete the objects
    await s3.deleteObjects(deleteParams).promise();
    res.json({
      message: `Folder "${folderPath}" and its contents have been deleted.`,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "Failed to delete folder and its contents." });
  }
});

// Delete a file
app.delete("/files/*", async (req, res) => {
  const filePath = req.params[0]; // Capture full path after /files/

  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Key: filePath,
  };

  try {
    await s3.deleteObject(params).promise();
    res.json({ message: `File "${filePath}" deleted successfully.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete file." });
  }
});
app.post("/convert", (req, res) => {
  console.log("Received request to convert LAZ file.");

  const inputPath =
    "D:\\AIVOLVED-JOB\\POTREE-CONVERTER-NODEJS\\uploads\\Palac_Moszna.laz"; // Default for testing
  const outputPath = "D:\\AIVOLVED-JOB\\POTREE-CONVERTER-NODEJS\\abc"; // Default for testing
  const potreeConverterPath =
    "D:\\AIVOLVED-JOB\\POTREE-CONVERTER-NODEJS\\PotreeConverter.exe";
  const potreeCommand = [
    inputPath,
    "-o",
    outputPath,
    "--generate-page",
    "Palac_Moszna",
  ];

  // Run the conversion in a child process
  const conversionProcess = spawn(potreeConverterPath, potreeCommand);

  conversionProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
  });

  conversionProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
  });

  conversionProcess.on("close", (code) => {
    console.log(`Conversion process exited with code ${code}`);
    // Ensure we respond only once
    if (!res.headersSent) {
      if (code === 0) {
        return res.json({ message: "Conversion completed successfully." });
      } else {
        return res.status(500).json({ message: "Conversion failed." });
      }
    }
  });

  conversionProcess.on("error", (err) => {
    console.error(`Failed to start conversion process: ${err}`);
    // Respond to client if process fails to start
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ message: "Failed to start conversion process." });
    }
  });
});


app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
