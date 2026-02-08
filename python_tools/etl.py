import asyncio
import logging
from crawler.crawler import BankCrawler
from ai.parser import RewardsParser
from db.operations import DatabaseOps

# 設定 Logger
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

async def main():
    db = DatabaseOps()
    crawler = BankCrawler(headless=True)
    parser = RewardsParser()

    # 1. 為了 Demo，我們先手動建立一張卡片與銀行
    # 實際應用中，這可能來自另一個種子列表
    try:
        bank_id = db.get_or_create_bank("台北富邦銀行", "012")
        card_id = db.get_or_create_card(bank_id, "富邦 J 卡", "https://www.fubon.com/banking/personal/credit_card/all_card/j_card/j_card_rates.htm")
        
        target_url = "https://www.fubon.com/banking/personal/credit_card/all_card/j_card/j_card_rates.htm"
        
        logger.info(f"Processing Card: 富邦 J 卡 (ID: {card_id})")

        # 2. 取得上次 Hash
        last_version = db.get_latest_card_version(card_id)
        last_hash = last_version['source_content_hash'] if last_version else None
        
        # 3. 爬取並比對
        crawl_result = await crawler.process_card_url(card_id, target_url, last_hash)
        
        if crawl_result['status'] == "NO_CHANGE":
            logger.info("Content not changed. Skipping AI parse.")
            db.log_crawl_result(card_id, "NO_CHANGE")
            return

        if crawl_result['status'] == "FAILED":
            logger.error(f"Crawl failed: {crawl_result.get('error')}")
            db.log_crawl_result(card_id, "FAILED", crawl_result.get('error'))
            return

        # 4. 若有變更 (CHANGED)，呼叫 AI 解析
        logger.info("Content changed. Calling AI Parser...")
        markdown_content = crawl_result['content']
        current_hash = crawl_result['hash']
        
        rewards_json = parser.parse_markdown_to_json(markdown_content)
        
        if "error" in rewards_json:
             logger.error(f"AI Parse failed: {rewards_json['error']}")
             db.log_crawl_result(card_id, "AI_FAILED", rewards_json['error'])
             return

        # 5. 寫入 DB
        logger.info("AI Parse success. Saving to DB...")
        db.save_card_version(
            card_id=card_id,
            version_name="2026-Q1", # 實際名稱可能需要更動態
            hash_val=current_hash,
            rewards=rewards_json,
            raw_content=markdown_content
        )
        db.log_crawl_result(card_id, "SUCCESS")
        logger.info("ETL process completed successfully.")

    except Exception as e:
        logger.error(f"ETL fatal error: {str(e)}")

if __name__ == "__main__":
    asyncio.run(main())
