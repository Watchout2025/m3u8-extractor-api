const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

exports.handler = async (event, context) => {
  // Set timeout for the function
  context.callbackWaitsForEmptyEventLoop = false;

  // Handle CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Get URL from query parameters or body
    let targetUrl;
    if (event.httpMethod === 'GET') {
      targetUrl = event.queryStringParameters?.url;
    } else if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      targetUrl = body.url;
    }

    if (!targetUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Missing url parameter. Usage: /extract?url=https://example.com'
        })
      };
    }

    // Validate URL
    try {
      new URL(targetUrl);
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Invalid URL provided'
        })
      };
    }

    console.log('Extracting M3U8 from:', targetUrl);

    const m3u8Links = await extractM3U8WithBrowser(targetUrl);

    if (m3u8Links.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'No M3U8 links found on the webpage'
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        url: targetUrl,
        m3u8Links: m3u8Links,
        primaryLink: m3u8Links[0],
        timestamp: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: `Internal server error: ${error.message}`
      })
    };
  }
};

async function extractM3U8WithBrowser(targetUrl) {
  let browser = null;
  
  try {
    console.log('Launching browser...');
    
    // Configure Chromium for Netlify
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    const m3u8Links = new Set();

    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Block images and fonts to speed up loading
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      const url = request.url();
      
      // Capture M3U8 URLs
      if (url.includes('.m3u8')) {
        console.log('Found M3U8 in request:', url);
        m3u8Links.add(url);
      }
      
      // Block unnecessary resources
      if (['image', 'font', 'stylesheet'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    page.on('response', (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      
      if (url.includes('.m3u8') || contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl')) {
        console.log('Found M3U8 in response:', url);
        m3u8Links.add(url);
      }
    });

    console.log('Navigating to page...');
    
    // Navigate with timeout
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 25000
    });

    console.log('Waiting for dynamic content...');
    
    // Wait for potential dynamic loading
    await page.waitForTimeout(5000);

    console.log('Searching for M3U8 in page content...');

    // Execute JavaScript to find M3U8 links
    const pageM3u8Links = await page.evaluate(() => {
      const links = new Set();
      
      // Search in all script tags
      const scripts = document.querySelectorAll('script');
      scripts.forEach(script => {
        const content = script.textContent || script.innerText || '';
        const m3u8Matches = content.match(/https?:\/\/[^\s"'<>(){}[\]]+\.m3u8(?:\?[^\s"'<>(){}[\]]*)?/gi);
        if (m3u8Matches) {
          m3u8Matches.forEach(link => {
            console.log('Found M3U8 in script:', link);
            links.add(link);
          });
        }
      });

      // Check common video player configurations
      const videoConfigs = [
        'jwplayer', 'videojs', 'Hls', 'hlsPlayer', 'player', 
        'videoPlayer', 'streamPlayer', 'mediaPlayer', 'jwConfig'
      ];

      videoConfigs.forEach(configName => {
        try {
          if (window[configName]) {
            const configStr = JSON.stringify(window[configName]);
            const m3u8Matches = configStr.match(/https?:\/\/[^\s"'<>(){}[\]]+\.m3u8(?:\?[^\s"'<>(){}[\]]*)?/gi);
            if (m3u8Matches) {
              m3u8Matches.forEach(link => {
                console.log('Found M3U8 in config:', link);
                links.add(link);
              });
            }
          }
        } catch (e) {
          // Skip if can't access
        }
      });

      // Look for data attributes
      const elementsWithData = document.querySelectorAll('*');
      elementsWithData.forEach(el => {
        ['data-src', 'data-url', 'data-stream', 'data-file', 'src'].forEach(attr => {
          const value = el.getAttribute(attr);
          if (value && value.includes('.m3u8')) {
            console.log('Found M3U8 in attribute:', value);
            links.add(value);
          }
        });
      });

      // Search in inline styles and text content
      const allText = document.documentElement.innerHTML;
      const m3u8Matches = allText.match(/https?:\/\/[^\s"'<>(){}[\]]+\.m3u8(?:\?[^\s"'<>(){}[\]]*)?/gi);
      if (m3u8Matches) {
        m3u8Matches.forEach(link => {
          console.log('Found M3U8 in HTML:', link);
          links.add(link);
        });
      }

      return Array.from(links);
    });

    // Combine all found links
    pageM3u8Links.forEach(link => m3u8Links.add(link));

    console.log('Total M3U8 links found:', m3u8Links.size);

    return Array.from(m3u8Links).filter(link => {
      try {
        const url = new URL(link);
        return url.pathname.includes('.m3u8');
      } catch (e) {
        return false;
      }
    });

  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
    }
  }
}
