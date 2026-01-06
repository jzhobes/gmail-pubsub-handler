import { PDFParse } from 'pdf-parse';

export default class SunrunClient {
  /**
   * Extracts the bill PDF and date from a Sunrun email message.
   *
   * @param {Object} message - The Gmail message object
   * @param {Object} gmailService - The Gmail API service instance
   * @returns {Promise<{buffer: Buffer, filename: string}|null>}
   */
  async getBillFromMessage(message, gmailService) {
    // Extract PDF attachment
    const pdfAttachment = await this.extractPdfAttachment(
      message,
      gmailService
    );
    if (!pdfAttachment) {
      console.error('❌ No PDF attachment found in Sunrun email');
      return null;
    }

    // Extract date from PDF
    let dateStr;
    try {
      const extractedDate = await this.extractBillDetailsFromPdf(
        pdfAttachment.data
      );
      if (extractedDate) {
        dateStr = extractedDate;
        console.log(`📅 Extracted date from PDF: ${dateStr}`);
      }
    } catch (pdfErr) {
      console.warn(`⚠️ PDF date extraction failed: ${pdfErr.message}`);
    }

    // Fallback to email date if extraction failed
    if (!dateStr) {
      console.warn('⚠️ Falling back to email date for Sunrun bill');
      const dateHeader = message.data.payload.headers.find(
        (h) => h.name === 'Date'
      )?.value;
      const emailDate = dateHeader ? new Date(dateHeader) : new Date();
      dateStr = emailDate.toISOString().split('T')[0]; // yyyy-mm-dd
    }

    return {
      buffer: pdfAttachment.data,
      fileName: `Sunrun_Bill_${dateStr}.pdf`,
    };
  }

  /**
   * Extracts bill details (date) from PDF buffer.
   *
   * @param {Buffer} pdfBuffer
   * @returns {Promise<string|null>} YYYY-MM-DD or null
   */
  async extractBillDetailsFromPdf(pdfBuffer) {
    let parser = null;
    try {
      parser = new PDFParse({ data: pdfBuffer });
      const data = await parser.getText();
      const text = data.text;

      // Regex for "Billing Period: MM/DD - MM/DD" or "Billing Period: Mon DD - Mon DD"
      // Example: "Billing Period: 10/01 - 10/31" or "Billing Period: Oct 15 - Nov 14"
      const billingPeriodRegex =
        /Billing Period[:\s]+([A-Za-z]{3}\s+\d{1,2}|\d{1,2}\/\d{1,2})\s*-\s*([A-Za-z]{3}\s+\d{1,2}|\d{1,2}\/\d{1,2})/i;
      const billingMatch = text.match(billingPeriodRegex);

      // Regex for "Due Date: MM/DD/YYYY"
      const dueDateRegex = /Due Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i;
      const dueMatch = text.match(dueDateRegex);

      if (!billingMatch || !dueMatch) {
        console.warn('Could not find Billing Period or Due Date in PDF text');
        return null;
      }

      const billingEndDateStr = billingMatch[2]; // "10/31" or "Nov 14"
      const dueDateStr = dueMatch[1]; // "11/16/2023"

      const parseDatePart = (str) => {
        if (str.includes('/')) {
          const [m, d] = str.split('/').map(Number);
          return { month: m, day: d };
        } else {
          const [mStr, dStr] = str.split(/\s+/);
          const monthMap = {
            jan: 1,
            feb: 2,
            mar: 3,
            apr: 4,
            may: 5,
            jun: 6,
            jul: 7,
            aug: 8,
            sep: 9,
            oct: 10,
            nov: 11,
            dec: 12,
          };
          return {
            month: monthMap[mStr.toLowerCase().substring(0, 3)],
            day: parseInt(dStr, 10),
          };
        }
      };

      const { month: billEndMonth, day: billEndDay } =
        parseDatePart(billingEndDateStr);
      const [dueMonth, , dueYear] = dueDateStr.split('/').map(Number);

      let year = dueYear;

      // If billing month is significantly greater than due month (e.g. Dec vs Jan),
      // it means the bill is for the previous year.
      if (billEndMonth > dueMonth) {
        year = dueYear - 1;
      }

      const pad = (n) => n.toString().padStart(2, '0');
      return `${year}-${pad(billEndMonth)}-${pad(billEndDay)}`;
    } catch (error) {
      console.error('Error parsing PDF:', error);
      return null;
    } finally {
      if (parser) {
        await parser.destroy();
      }
    }
  }

  /**
   * Extracts the first PDF attachment from a Gmail message.
   *
   * @param {Object} message - Gmail message object
   * @param {Object} gmailService - Gmail API service
   * @returns {Promise<{data: Buffer, filename: string} | null>}
   */
  async extractPdfAttachment(message, gmailService) {
    const parts = message.data.payload.parts || [];

    // Recursively search for PDF attachments
    const findPdfPart = (parts) => {
      for (const part of parts) {
        // Check if this part is a PDF
        if (part.mimeType === 'application/pdf' && part.body?.attachmentId) {
          return part;
        }
        // Recursively check nested parts
        if (part.parts) {
          const found = findPdfPart(part.parts);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };

    const pdfPart = findPdfPart(parts);
    if (!pdfPart) {
      return null;
    }

    // Download the attachment
    const attachment = await gmailService.users.messages.attachments.get({
      userId: 'me',
      messageId: message.data.id,
      id: pdfPart.body.attachmentId,
    });

    return {
      data: Buffer.from(attachment.data.data, 'base64'),
      filename: pdfPart.filename || 'attachment.pdf',
    };
  }
}
