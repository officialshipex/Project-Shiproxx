const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const BaseRateCard = require("../models/baseRateCard.model");
const { editBaseRate } = require("./editBaseRateController");


const saveBaseRate = async (req, res) => {
  try {

    const { courierServiceName, mode } = req.body;

    const existingRateCard = await BaseRateCard.findOne({ courierServiceName, mode });

    if (existingRateCard) {
      return res.status(201).json({ message: "Costing Rate Card already exists." });
    }

    const newRateCard = new BaseRateCard(req.body);
    await newRateCard.save();

    res.status(201).json({ message: "Costing Rate Card Saved Successfully" });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
};




const uploadBaseRate = async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const filePath = path.join(__dirname, '../uploads', req.file.filename);

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    let parsedData;
    try {
      parsedData = JSON.parse(req.body.data);
    } catch (error) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return res.status(400).send('Invalid JSON data.');
    }

    const { courierProviderName } = parsedData;
    
    let service = '';
    let mode = 'Surface';

    let prevRateCard=null;
    for (const item of data) {
      if (item.Courier) {
        service = item.Courier;
        mode = item.mode || mode;
        const existingBaseCard = await BaseRateCard.findOne({ courierProviderName, courierServiceName: service, mode });

        const transformedData = [{
          weight: parseFloat(item.Weight),
          zoneA: { forward: item['Zone A Forward']},
          zoneB: { forward: item['Zone B Forward']},
          zoneC: { forward: item['Zone C Forward']},
          zoneD: { forward: item['Zone D Forward']},
          zoneE: { forward: item['Zone E Forward']},
        }];

        if (existingBaseCard) {
          prevRateCard=existingBaseCard;

          existingBaseCard.weightPriceBasic = transformedData;
          existingBaseCard.codPercent = item['COD %'];
          existingBaseCard.codCharge = item['COD Charge'];
          existingBaseCard.mode = mode;

        } else {
          const newBaseRate = new BaseRateCard({
            courierProviderName,
            courierServiceName: service,
            mode,
            weightPriceBasic: transformedData,
            codPercent: item['COD %'],
            codCharge: item['COD Charge'],
          });

          await newBaseRate.save();
        }
        

      } else {
        const existingBaseCard = await BaseRateCard.findOne({ courierProviderName, courierServiceName: service, mode });
        const transformedData = [{
          weight: parseFloat(item.Weight.replace(/[^\d.-]/g, '')),
          zoneA: { forward: item['Zone A Forward']},
          zoneB: { forward: item['Zone B Forward']},
          zoneC: { forward: item['Zone C Forward']},
          zoneD: { forward: item['Zone D Forward']},
          zoneE: { forward: item['Zone E Forward']},
        }];

        console.log(transformedData);
       

        if (existingBaseCard) {
          existingBaseCard.weightPriceAdditional= transformedData;
          const updatedRateCard = await existingBaseCard.save();

         if(prevRateCard!=null){
          await editBaseRate(prevRateCard, updatedRateCard);
         }
        }
      }
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.status(201).json('File uploaded and data saved successfully.');

  } catch (error) {
    console.error('Error processing file:', error);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.status(500).json('Error processing file.');
  }
};



module.exports = { saveBaseRate, uploadBaseRate };
