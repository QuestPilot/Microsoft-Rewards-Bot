import { AxiosRequestConfig } from "axios";
import { randomBytes } from "crypto";

import { URLS } from "../../constants";
import { DashboardData } from "../../interface/DashboardData";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class ReadToEarn extends Workers {
  public async doReadToEarn(accessToken: string, data: DashboardData) {
    this.bot.log(this.bot.isMobile, "READ-TO-EARN", "Starting Read to Earn");

    try {
      const geoLocale = this.resolveGeoLocale(data);

      const userDataRequest: AxiosRequestConfig = {
        url: URLS.REWARDS_API_ME,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Rewards-Country": geoLocale,
          "X-Rewards-Language": "en",
        },
      };
      const userDataResponse = await this.bot.axios.request(userDataRequest);
      const userData = (await userDataResponse.data).response;
      let userBalance = userData.balance;

      const jsonData = {
        amount: 1,
        country: geoLocale,
        id: "1",
        type: 101,
        attributes: {
          offerid: "ENUS_readarticle3_30points",
        },
      };

      const articleCount = 10;
      for (let i = 0; i < articleCount; ++i) {
        jsonData.id = randomBytes(64).toString("hex");
        const claimRequest = {
          url: URLS.REWARDS_API_ACTIVITIES,
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Rewards-Country": geoLocale,
            "X-Rewards-Language": "en",
          },
          data: JSON.stringify(jsonData),
        };

        const claimResponse = await this.bot.axios.request(claimRequest);
        const newBalance = (await claimResponse.data).response.balance;

        if (newBalance === userBalance) {
          this.bot.log(
            this.bot.isMobile,
            "READ-TO-EARN",
            "Read all available articles",
          );
          break;
        } else {
          this.bot.log(
            this.bot.isMobile,
            "READ-TO-EARN",
            `Read article ${i + 1} of ${articleCount} max | Gained ${newBalance - userBalance} Points`,
          );
          userBalance = newBalance;
          await this.bot.utils.wait(
            Math.floor(
              this.bot.utils.randomNumber(
                this.bot.utils.stringToMs(
                  this.bot.config.searchSettings.searchDelay.min,
                ),
                this.bot.utils.stringToMs(
                  this.bot.config.searchSettings.searchDelay.max,
                ),
              ),
            ),
          );
        }
      }

      this.bot.log(this.bot.isMobile, "READ-TO-EARN", "Completed Read to Earn");
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "READ-TO-EARN",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
