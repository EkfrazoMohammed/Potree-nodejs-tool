import express from "express";
import multer from "multer";
import AWS from "aws-sdk";
import dotenv from "dotenv";
// import execa from "execa"; // Use import instead of require
import { exec, spawn } from "child_process"; // Include spawn here
import { execFile } from "child_process";
import bodyParser from "body-parser";
import fs from "fs";
import unzipper from "unzipper";

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

// Upload ZIP endpoint
app.post("/upload-zip/:path*", upload.single("zipFile"), async (req, res) => {
  const zipPath = req.params.path; // Capture the path after /upload-zip/
  const zipFile = req.file; // The uploaded file

  // Check if file is provided
  if (!zipFile) {
    return res.status(400).json({ error: "No ZIP file uploaded." });
  }

  try {
    const filesUploaded = [];

    // Process the ZIP file stream
    await new Promise((resolve, reject) => {
      // Use unzipper to extract the ZIP contents
      const stream = unzipper.Parse();

      // Create a stream from the uploaded ZIP file buffer
      stream.on("entry", async (entry) => {
        const fileName = entry.path; // Get the name of the file in the ZIP
        const params = {
          Bucket: process.env.DO_SPACE_NAME,
          Key: `${zipPath}/${fileName}`, // Set the full path in the bucket
          Body: entry, // Use the entry stream as the body
          ACL: "public-read", // Make the file publicly accessible
        };

        try {
          // Upload the file to DigitalOcean Spaces
          await s3.upload(params).promise();
          filesUploaded.push(fileName);
          entry.autodrain(); // Skip the file entry
        } catch (error) {
          console.error(error);
          reject(error); // Reject the promise if upload fails
        }
      });

      stream.on("finish", resolve); // Resolve the promise when done
      stream.on("error", reject); // Reject on stream error

      // Start the extraction process
      stream.end(zipFile.buffer); // End the stream with the buffer
    });

    res.json({
      message: `Successfully uploaded ${filesUploaded.length} files from ZIP.`,
      files: filesUploaded,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to upload files from ZIP." });
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

// Helper function to format file size
const formatFileSize = (bytes) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

app.get("/folders/*", async (req, res) => {
  const folderPath = req.params[0]; // Capture full path after /folders/

  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Prefix: `${folderPath}/`,
    Delimiter: "/", // Use delimiter to get only the first level of "folders"
  };

  try {
    const data = await s3.listObjectsV2(params).promise();

    // Get total size of files in the folder
    let totalSize = 0;
    const files = data.Contents.map((file) => {
      totalSize += file.Size;
      return {
        file: file.Key,
        size: formatFileSize(file.Size), // Size in human-readable format
        signedUrl: s3.getSignedUrl("getObject", {
          Bucket: process.env.DO_SPACE_NAME,
          Key: file.Key,
          Expires: 60 * 5, // URL expires in 5 minutes
        }),
      };
    });

    const commonPrefixes = data.CommonPrefixes.map((prefix) => prefix.Prefix);

    // Return the total size along with file and folder information
    res.json({
      totalSize: formatFileSize(totalSize), // Total size of files in human-readable format
      files,
      folders: commonPrefixes,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to retrieve folder contents." });
  }
});

// Upload multiple files to a specified path
app.post("/files/*", upload.array("file", 10), async (req, res) => {
  const filePath = req.params[0]; // Capture full path after /files/
  const files = req.files;

  // Check if files are provided
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded." });
  }

  const uploadedFiles = [];

  for (const file of files) {
    const params = {
      Bucket: process.env.DO_SPACE_NAME,
      Key: `${filePath}/${file.originalname}`, // Full path in the bucket
      Body: file.buffer,
      ACL: "public-read", // Ensure the file is publicly accessible
      ContentType: file.mimetype, // Use the correct MIME type
    };

    try {
      // Upload the file to DigitalOcean Spaces
      await s3.upload(params).promise();
      uploadedFiles.push({
        fileName: file.originalname,
        message: `File "${file.originalname}" uploaded to "${filePath}".`,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Failed to upload some files." });
    }
  }

  res.json({ uploadedFiles });
});

app.get("/files/*", async (req, res) => {
  const filePath = req.params[0]; // Capture full path after /files/

  const params = {
    Bucket: process.env.DO_SPACE_NAME,
    Key: filePath,
  };

  try {
    const headData = await s3.headObject(params).promise(); // Fetch file metadata, including size
    const size = headData.ContentLength; // Size in bytes

    const url = s3.getSignedUrl("getObject", {
      Bucket: process.env.DO_SPACE_NAME,
      Key: filePath,
      Expires: 60 * 5, // URL expires in 5 minutes
    });

    res.json({ url, size: formatFileSize(size) }); // Return file URL and formatted size
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
