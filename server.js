const express = require('express');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');  // 用于处理路径
const config = require('./public/config'); // 导入配置文件
const rateLimit = require('express-rate-limit'); // 用于请求频率限制
const app = express();
const port = 3000;

// 提供 'public' 目录中的静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 允许跨源请求
app.use(cors());
app.use(bodyParser.json());  // 解析 JSON 请求体

// 配置请求频率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15分钟
  max: 100,  // 每15分钟最多100个请求
  message: 'Too many requests, please try again later.'
});
app.use(limiter);

// 加载 Google API 凭证
const credentials = require('./credentials.json');
const SPREADSHEET_ID = config.SPREADSHEET_ID; // 从配置文件获取 Google 表格 ID

// 设置 Google Sheets API 认证
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: 'https://www.googleapis.com/auth/spreadsheets',
});

const sheets = google.sheets({ version: 'v4', auth });

// 通用功能：获取 Google Sheets 数据
async function getSheetData(range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
    });
    return response.data.values || []; // 确保返回的是数组，防止返回 undefined
  } catch (error) {
    console.error('Error retrieving data from Google Sheets:', error);
    throw new Error('Error retrieving data');
  }
}

// 格式化行数据
function formatRowData(row, validColumns, selectedDate) {
  const name = row[1] ? row[1].trim() : '';
  const caregiver = row[5] ? row[5].trim() : '';

  if (!name || !caregiver || name === '序') return null;

  const attendance = row.slice(6, 24).map(cell => cell ? cell.trim() : '');
  const selectedColumnIndex = validColumns.indexOf(selectedDate);
  const selectedAttendance = attendance[selectedColumnIndex] || '';

  return { name, caregiver, selectedAttendance };
}

// 路由：获取 Google Sheets 数据
app.get('/getData', async (req, res) => {
  const { selectedDate, hall } = req.query;  // 获取前端传来的日期和 hall 参数
  console.log('Received selected date:', selectedDate);
  console.log('Received hall:', hall);

  try {
    // 从配置文件获取有效的日期列
    const validColumns = config.VALID_COLUMNS;
    if (!validColumns.includes(selectedDate)) {
      return res.status(400).send({ message: 'Invalid date selected' });
    }

    // 根据 hall 参数选择工作表名称
    const sheetName = config.HALLS[hall] || '3會所'; // 默认选择 3會所

    const sheetInfo = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });

    // 确保指定的工作表存在
    const sheet = sheetInfo.data.sheets.find(sheet => sheet.properties.title === sheetName); 
    if (!sheet) {
      return res.status(400).send({ message: `Sheet with name "${sheetName}" does not exist.` });
    }

    const totalRows = sheet.properties.gridProperties.rowCount; // 获取行数

    const RANGE = `${sheetName}!A12:X${totalRows}`; // 从第12行开始
    const sheetData = await getSheetData(RANGE);
    console.log(sheet, RANGE);
    if (!sheetData.length) {
      return res.status(400).send({ message: 'No data found in the sheet.' });
    }

    const groupedData = {};
    const nameToRowIndexMap = {};

    sheetData.forEach((row, rowIndex) => {
      const formattedData = formatRowData(row, validColumns, selectedDate);
      if (!formattedData) return;

      const { name, caregiver, selectedAttendance } = formattedData;

      if (!groupedData[caregiver]) {
        groupedData[caregiver] = [];
      }

      groupedData[caregiver].push({ name, attendance: selectedAttendance });
      nameToRowIndexMap[name] = rowIndex + 12;  // 计算行号，+12 是因为数据从第12行开始
    });

    res.json({ groupedData, nameToRowIndexMap });
  } catch (err) {
    console.error('Error retrieving data:', err);
    res.status(500).json({ message: 'Error retrieving data', error: err.message });
  }
});

// 路由：提交修改的数据
app.post('/updateData', async (req, res) => {
  const { updatedData, nameToRowIndexMap, selectedDate, hall } = req.body;
  console.log('Received updated data:', updatedData);

  try {
    // 获取对应的日期列索引
    const validColumns = config.VALID_COLUMNS;
    const columnIndex = validColumns.indexOf(selectedDate);
    if (columnIndex === -1) {
      return res.status(400).send({ message: 'Invalid date selected' });
    }

    // 根据 hall 参数选择工作表名称
    const sheetName = config.HALLS[hall] || '3會所'; // 默认选择 3會所
    const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });

    const sheet = sheetInfo.data.sheets.find(sheet => sheet.properties.title === sheetName);
    const sheetId = sheet.properties.sheetId;

    // 遍历照顾者数据，生成批量更新请求
    const requests = [];
    for (const caregiver in updatedData) {
      // 确保 updatedData[caregiver] 是一个数组
      if (Array.isArray(updatedData[caregiver])) {
        updatedData[caregiver].forEach(person => {
          const rowIndex = nameToRowIndexMap[person.name];

          if (rowIndex) {
            const cellValue = person.selectedOptions.join(', ');

            const request = {
              updateCells: {
                rows: [{
                  values: [{
                    userEnteredValue: { stringValue: cellValue }
                  }]
                }],
                fields: 'userEnteredValue',
                start: {
                  sheetId: sheetId,
                  rowIndex: rowIndex - 1, // 从 0 开始
                  columnIndex: columnIndex + 6 // 从第6列开始
                }
              }
            };

            requests.push(request);
          }
        });
      } else {
        console.error(`Expected array for caregiver ${caregiver}, but got:`, updatedData[caregiver]);
      }
    }

    // 批量更新 Google Sheets
    const batchUpdateRequest = { requests };
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: batchUpdateRequest
    });

    console.log('Update successful', response);
    res.status(200).send({ message: 'Data updated successfully' });

  } catch (error) {
    console.error('Error updating data:', error);
    res.status(500).json({ message: 'Error updating data', error: error.message });
  }
});

// 启动服务器
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});